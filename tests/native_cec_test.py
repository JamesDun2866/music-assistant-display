"""Hardware-free CEC tests; Linux also checks ctypes against the system UAPI."""

import ctypes
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import unittest
from unittest.mock import patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("native_cec", ROOT / "src" / "server" / "native-cec.py")
cec = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cec)


def clone(value):
    return type(value).from_buffer_copy(bytes(value))


def packet(payload=(0x04, 0x44, 0x01), sequence=0, tx=0, rx=1):
    result = cec.CecMsg()
    result.len = len(payload)
    result.msg[:len(payload)] = payload
    result.sequence = sequence
    result.tx_status = tx
    result.rx_status = rx
    return result


def state(physical=0x1200, mask=16, flags=0, connector=1):
    event = cec.CecEvent()
    event.event = cec.CEC_EVENT_STATE_CHANGE
    event.flags = flags
    event.state_change.phys_addr = physical
    event.state_change.log_addr_mask = mask
    event.state_change.have_conn_info = connector
    return event


def lost(flags=0):
    event = cec.CecEvent()
    event.event = cec.CEC_EVENT_LOST_MSGS
    event.flags = flags
    event.lost_msgs.lost_msgs = 3
    return event


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


class FakePoll:
    def __init__(self, clock):
        self.clock = clock
        self.registered = []
        self.responses = []
        self.timeouts = []
        self.on_poll = None

    def register(self, fd, mask):
        self.registered.append((fd, mask))

    def poll(self, timeout):
        self.timeouts.append(timeout)
        self.clock.now += timeout / 1000
        if self.on_poll:
            self.on_poll()
        response = self.responses.pop(0) if self.responses else []
        if isinstance(response, Exception):
            raise response
        return response


class FakeDevice:
    def __init__(self):
        self.fd = 19
        self.closed = False
        self.calls = []
        self.physical = 0x1200
        self.caps = cec.CecCaps()
        self.caps.capabilities = cec.CEC_CAP_LOG_ADDRS | cec.CEC_CAP_TRANSMIT
        self.caps.available_log_addrs = 1
        self.addresses = cec.CecLogAddrs()
        self.mode = 1
        self.claim_address = 4
        self.claim_immediately = True
        self.claim_flags = 0
        self.claim_error = None
        self.clear_error = None
        self.clear_ignored = False
        self.close_error = None
        self.query_error = None
        self.removed = False
        self.mode_error = None
        self.mode_override = None
        self.race_owner = False
        self.events = [state(mask=0, flags=cec.CEC_EVENT_FL_INITIAL_STATE)]
        self.messages = []
        self.sequence = 1
        self.immediate_status = 0
        self.tx_error = None
        self.kernel_transmits = []

    def claim(self):
        self.addresses.log_addr[0] = self.claim_address
        self.addresses.log_addr_mask = 1 << self.claim_address
        self.addresses.flags = self.claim_flags
        self.events.append(state(mask=self.addresses.log_addr_mask))

    def ioctl(self, request, value):
        self.calls.append((request, clone(value)))
        if self.removed:
            raise cec.CecError("disconnected", error_number=errno.ENODEV)
        if request == cec.CEC_ADAP_G_CAPS:
            return clone(self.caps)
        if request == cec.CEC_ADAP_G_PHYS_ADDR:
            return ctypes.c_uint16(self.physical)
        if request == cec.CEC_ADAP_G_LOG_ADDRS:
            if self.query_error:
                raise self.query_error
            return clone(self.addresses)
        if request == cec.CEC_S_MODE:
            if self.mode_error:
                raise self.mode_error
            self.mode = value.value
            if self.race_owner:
                self.addresses.num_log_addrs = 1
            return value
        if request == cec.CEC_G_MODE:
            return ctypes.c_uint32(self.mode if self.mode_override is None else self.mode_override)
        if request == cec.CEC_ADAP_S_LOG_ADDRS:
            if value.num_log_addrs and self.claim_error:
                raise self.claim_error
            if not value.num_log_addrs:
                if self.clear_error:
                    raise self.clear_error
                if self.clear_ignored:
                    return clone(self.addresses)
            self.addresses = clone(value)
            if value.num_log_addrs and self.claim_immediately:
                self.claim()
            return clone(self.addresses)
        if request == cec.CEC_DQEVENT:
            if not self.events:
                raise BlockingIOError(errno.EAGAIN, "empty")
            return self.events.pop(0)
        if request == cec.CEC_RECEIVE:
            if not self.messages:
                raise BlockingIOError(errno.EAGAIN, "empty")
            return self.messages.pop(0)
        if request == cec.CEC_TRANSMIT:
            if self.tx_error:
                raise self.tx_error
            self.kernel_transmits.append(clone(value))
            result = clone(value)
            result.sequence = self.sequence
            self.sequence += 1
            result.tx_status = self.immediate_status
            return result
        raise AssertionError("Unexpected ioctl")

    def close(self):
        self.closed = True
        self.mode = 1
        self.messages = []
        self.events = []
        # Kernel release drops the exclusive owner, not logical registration;
        # pending transmits are unhooked, not guaranteed to be cancelled.
        if self.close_error:
            raise self.close_error

    def reopen(self):
        assert self.closed
        self.closed = False
        self.fd += 1
        self.events = [state(physical=self.physical, mask=self.addresses.log_addr_mask,
                             flags=cec.CEC_EVENT_FL_INITIAL_STATE)]

    def remove_adapter(self):
        # cec_devnode_unregister, unlike close(2), clears adapter configuration.
        self.removed = True
        self.physical = 0xFFFF
        self.addresses = cec.CecLogAddrs()

    def replug_adapter(self):
        assert self.removed
        self.removed = False
        self.physical = 0x1200
        self.reopen()

    def transmitted(self):
        return [value for request, value in self.calls if request == cec.CEC_TRANSMIT]

    def registrations(self):
        return [value for request, value in self.calls if request == cec.CEC_ADAP_S_LOG_ADDRS]


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.device = FakeDevice()
        self.output = []
        self.clock = Clock()
        self.poller = FakePoll(self.clock)
        self.stopping = False
        self.runtime = cec.Runtime(self.device, self.output.append,
                                   poll_factory=lambda: self.poller, clock=self.clock,
                                   stopped=lambda: self.stopping)
        self.addCleanup(self.runtime.close)

    def error(self, code, operation):
        with self.assertRaises(cec.CecError) as caught:
            operation()
        self.assertEqual(caught.exception.code, code)

    def test_start_and_close_never_send_power_or_source_commands(self):
        self.runtime.start()
        self.assertEqual(self.output, [{"type": "ready", "logicalAddress": 4, "physicalAddress": 0x1200}])
        registration, = self.device.registrations()
        self.assertEqual(registration.num_log_addrs, 1)
        self.assertEqual(registration.flags, 0)
        self.assertEqual(registration.cec_version, cec.CEC_OP_CEC_VERSION_1_4)
        self.assertEqual(registration.log_addr_type[0], cec.CEC_LOG_ADDR_TYPE_PLAYBACK)
        self.assertEqual(registration.primary_device_type[0], cec.CEC_OP_PRIM_DEVTYPE_PLAYBACK)
        self.assertEqual(registration.vendor_id, cec.CEC_VENDOR_ID_NONE)
        self.assertEqual(registration.osd_name, b"Sendspin")
        self.assertEqual(self.device.mode, 0x22)
        self.runtime.close()
        self.runtime.close()
        self.assertTrue(self.device.closed)
        self.assertEqual([item.num_log_addrs for item in self.device.registrations()], [1, 0])
        self.assertEqual(self.device.transmitted(), [])

    def test_all_three_playback_addresses(self):
        for address in (4, 8, 11):
            with self.subTest(address=address):
                device, output = FakeDevice(), []
                device.claim_address = address
                runtime = cec.Runtime(device, output.append, poll_factory=lambda: self.poller)
                try:
                    runtime.start()
                    self.assertEqual(output[-1]["logicalAddress"], address)
                finally:
                    runtime.close()

    def test_reconnect_never_replays_pending_user_actions(self):
        self.runtime.start()
        self.runtime.command({"id": 1, "command": "wake"})
        self.runtime.close()
        self.device.reopen()
        output = []
        other = cec.Runtime(self.device, output.append, poll_factory=lambda: self.poller)
        try:
            other.start()
            self.assertEqual(len(self.device.transmitted()), 1)
            self.assertEqual(output, [{"type": "ready", "logicalAddress": 4, "physicalAddress": 0x1200}])
        finally:
            other.close()

    def test_abrupt_helper_death_preserves_registration_and_cannot_auto_reclaim(self):
        self.runtime.start()
        self.runtime.command({"id": 1, "command": "wake"})
        configured = bytes(self.device.addresses)
        # Simulate SIGKILL: only the kernel's filehandle release runs.
        self.device.close()
        self.runtime.closed = True
        self.assertEqual(self.device.mode, 1)
        self.assertEqual(bytes(self.device.addresses), configured)
        self.assertEqual(len(self.device.kernel_transmits), 1)
        self.device.reopen()
        calls_before_restart = len(self.device.calls)
        output = []
        other = cec.Runtime(self.device, output.append, poll_factory=lambda: self.poller)
        try:
            self.error("registration-present", other.start)
        finally:
            other.close()
        self.assertEqual(output, [])
        self.assertEqual(bytes(self.device.addresses), configured)
        self.assertEqual(self.device.addresses.osd_name, b"Sendspin")
        self.assertEqual(len(self.device.kernel_transmits), 1)
        self.assertTrue(all(request not in (cec.CEC_S_MODE, cec.CEC_ADAP_S_LOG_ADDRS, cec.CEC_TRANSMIT)
                            for request, _ in self.device.calls[calls_before_restart:]))

    def test_failed_registration_cleanup_is_explicit_and_still_closes_fd(self):
        self.runtime.start()
        self.device.clear_error = cec.CecError("busy")
        self.error("cleanup-failed", self.runtime.close)
        self.assertTrue(self.device.closed)
        self.assertEqual(self.device.addresses.num_log_addrs, 1)
        self.assertEqual(self.device.addresses.log_addr_mask, 16)
        self.assertEqual(self.device.mode, 1)

    def test_registration_cleanup_is_verified_before_releasing_exclusive_mode(self):
        self.runtime.start()
        self.device.clear_ignored = True
        self.error("cleanup-failed", self.runtime.close)
        self.assertTrue(self.device.closed)
        self.assertEqual(self.device.addresses.num_log_addrs, 1)

    def test_raw_cleanup_error_is_sanitized(self):
        self.runtime.start()
        self.device.clear_error = OSError(errno.EIO, "private driver details")
        self.error("cleanup-failed", self.runtime.close)
        self.assertTrue(self.device.closed)

    def test_fd_close_failure_is_sanitized(self):
        self.runtime.start()
        self.device.close_error = OSError(errno.EIO, "private driver details")
        self.error("cleanup-failed", self.runtime.close)
        self.assertEqual(self.device.addresses.num_log_addrs, 0)

    def test_proven_adapter_removal_is_explicit_and_replug_can_claim(self):
        self.runtime.start()
        self.runtime.command({"id": 1, "command": "wake"})
        self.device.remove_adapter()
        with self.assertRaises(cec.CecError) as caught:
            self.runtime.close()
        self.assertEqual(caught.exception.code, "adapter-removed")
        self.assertTrue(self.device.closed)
        self.assertEqual(self.device.addresses.num_log_addrs, 0)
        self.assertEqual(self.device.calls[-1][0], cec.CEC_ADAP_G_LOG_ADDRS)
        self.device.replug_adapter()
        output = []
        other = cec.Runtime(self.device, output.append, poll_factory=lambda: self.poller)
        try:
            other.start()
            self.assertEqual(output, [{"type": "ready", "logicalAddress": 4, "physicalAddress": 0x1200}])
            self.assertEqual(len(self.device.transmitted()), 1)
        finally:
            other.close()

    def test_enodev_from_clear_alone_does_not_prove_adapter_removed(self):
        self.runtime.start()
        self.device.clear_error = cec.CecError("disconnected", error_number=errno.ENODEV)
        self.error("cleanup-failed", self.runtime.close)
        self.assertEqual(self.device.addresses.num_log_addrs, 1)
        self.assertTrue(self.device.closed)

    def test_ambiguous_query_errors_cannot_become_adapter_removed(self):
        for number in (errno.EIO, errno.EBADF, errno.ENXIO, errno.EPERM):
            with self.subTest(number=number):
                device = FakeDevice()
                other = cec.Runtime(device, lambda _value: None, poll_factory=lambda: self.poller)
                other.start()
                device.clear_error = cec.CecError("busy")
                device.query_error = cec.CecError("disconnected", error_number=number)
                self.error("cleanup-failed", other.close)
                self.assertTrue(device.closed)
                self.assertEqual(device.addresses.num_log_addrs, 1)

    def test_close_failure_overrides_proven_removal_with_cleanup_failed(self):
        self.runtime.start()
        self.device.remove_adapter()
        self.device.close_error = OSError(errno.EIO, "private driver details")
        self.error("cleanup-failed", self.runtime.close)

    def test_waits_for_nonblocking_registration_without_pollout(self):
        self.device.claim_immediately = False
        self.poller.on_poll = self.device.claim
        self.runtime.start()
        self.assertEqual(self.poller.timeouts, [100])
        self.assertTrue(all(not mask & 4 for _, mask in self.poller.registered))

    def test_registration_timeout_is_bounded(self):
        self.device.claim_immediately = False
        self.error("no-logical-address", self.runtime.start)
        self.assertLessEqual(len(self.poller.timeouts), 101)
        self.assertEqual(self.output, [])

    def test_unsupported_capabilities_do_not_write(self):
        for capabilities, available in ((0, 1), (2, 1), (4, 1), (6, 0), (6, 5)):
            with self.subTest(capabilities=capabilities, available=available):
                self.device.caps.capabilities = capabilities
                self.device.caps.available_log_addrs = available
                self.error("unsupported", self.runtime.start)
        self.assertFalse(any(request == cec.CEC_S_MODE for request, _ in self.device.calls))
        self.assertEqual(self.device.registrations(), [])

    def test_no_edid_does_not_claim_or_set_a_physical_address(self):
        for address in (0xFFFF, 0, 0x1020):
            self.device.physical = address
            self.error("no-physical-address", self.runtime.start)
        self.assertEqual(self.device.registrations(), [])

    def test_existing_registration_is_present_and_never_cleared(self):
        for count, mask in ((1, 16), (1, 0), (0, 16)):
            self.device.addresses.num_log_addrs = count
            self.device.addresses.log_addr_mask = mask
            self.error("registration-present", self.runtime.start)
        self.runtime.close()
        self.assertEqual(self.device.registrations(), [])
        self.assertFalse(any(request == cec.CEC_S_MODE for request, _ in self.device.calls))

    def test_registration_race_after_exclusive_mode_is_not_cleared(self):
        self.device.race_owner = True
        self.error("registration-present", self.runtime.start)
        self.runtime.close()
        self.assertEqual(self.device.registrations(), [])

    def test_existing_owner_without_edid_is_still_registration_present(self):
        self.device.physical = 0xFFFF
        self.device.addresses.num_log_addrs = 1
        self.error("registration-present", self.runtime.start)
        self.runtime.close()
        self.assertEqual(self.device.registrations(), [])

    def test_failed_claim_or_exclusive_mode_never_clears_other_owner(self):
        self.device.claim_error = cec.CecError("busy")
        self.error("busy", self.runtime.start)
        self.runtime.close()
        self.assertEqual([item.num_log_addrs for item in self.device.registrations()], [1])
        self.assertFalse(self.runtime.owns_registration)

    def test_exclusive_mode_is_required(self):
        self.device.mode_error = cec.CecError("busy")
        self.error("busy", self.runtime.start)
        self.assertEqual(self.device.registrations(), [])

    def test_passthrough_or_shared_mode_is_rejected(self):
        for mode in (0x12, 0x32, 0xE0, 0xF0):
            self.device.mode_override = mode
            self.error("unsupported", self.runtime.start)
        self.assertEqual(self.device.registrations(), [])

    def test_rc_core_passthrough_is_verified_off(self):
        self.device.claim_flags = 2
        self.error("unsupported", self.runtime.start)
        self.assertEqual(self.output, [])

    def test_unregistered_address_is_not_accepted(self):
        self.device.claim_address = 15
        self.error("no-logical-address", self.runtime.start)

    def test_explicit_wake_and_active_source_payloads_and_acks(self):
        self.runtime.start()
        self.runtime.command({"id": 1, "command": "wake"})
        self.runtime.command({"id": 2, "command": "active-source"})
        transmissions = self.device.transmitted()
        self.assertEqual([list(item.msg[:item.len]) for item in transmissions],
                         [[0x40, 0x04], [0x4F, 0x82, 0x12, 0x00]])
        for item in transmissions:
            self.assertEqual((item.timeout, item.reply, item.flags), (0, 0, 0))
        self.assertEqual(len(self.output), 1)
        self.device.messages = [packet(sequence=2, tx=1, rx=0), packet(sequence=1, tx=0x24, rx=0)]
        self.runtime.receive()
        self.assertEqual(self.output[1:], [
            {"type": "result", "id": 2, "ok": True}, {"type": "result", "id": 1, "ok": False}])
        self.assertEqual(self.runtime.pending, {})

    def test_immediate_transmit_result(self):
        self.runtime.start()
        self.device.immediate_status = 1 | 2 | 4
        self.runtime.command({"id": 8, "command": "wake"})
        self.assertEqual(self.output[-1], {"type": "result", "id": 8, "ok": True})
        self.assertFalse(self.runtime.pending)

    def test_only_pending_tx_completion_is_ack_not_rx_reply_or_foreign_sequence(self):
        self.runtime.start()
        self.runtime.command({"id": 7, "command": "wake"})
        self.device.messages = [packet(sequence=1), packet(sequence=90, tx=1, rx=0),
                                packet(sequence=1, tx=1, rx=1)]
        self.runtime.receive()
        self.assertEqual(len(self.output), 1)
        self.assertEqual(len(self.runtime.pending), 1)
        self.device.messages = [packet(sequence=1, tx=1, rx=0)]
        self.runtime.receive()
        self.assertEqual(self.output[-1], {"type": "result", "id": 7, "ok": True})

    def test_received_packets_preserve_metadata_and_ignore_bad_status(self):
        self.runtime.start()
        self.device.messages = [packet(), packet(tx=1), packet(rx=0), packet(rx=3), packet(rx=8)]
        self.runtime.receive()
        self.assertEqual(self.output[1:], [
            {"type": "packet", "message": [4, 0x44, 1], "sequence": 0, "txStatus": 0, "rxStatus": 1}])

    def test_malformed_kernel_message_lengths(self):
        self.runtime.start()
        for length in (0, 17, 0xFFFFFFFF):
            value = packet()
            value.len = length
            self.device.messages = [value]
            self.error("protocol", self.runtime.receive)
        self.assertEqual(len(self.output), 1)

    def test_receive_eagain_is_benign(self):
        self.runtime.start()
        self.runtime.receive()
        self.assertEqual(len(self.output), 1)

    def test_tx_timeout_fails_without_replay(self):
        self.runtime.start()
        self.runtime.command({"id": 1, "command": "wake"})
        self.clock.now = 5.0
        self.runtime.expire_commands()
        self.device.messages = [packet(sequence=1, tx=1, rx=0)]
        self.runtime.receive()
        self.assertEqual(self.output[1:], [{"type": "result", "id": 1, "ok": False}])
        self.assertEqual(len(self.device.transmitted()), 1)

    def test_late_completion_cannot_succeed_before_expiry_sweep(self):
        self.runtime.start()
        self.runtime.command({"id": 1, "command": "wake"})
        self.clock.now = 5
        self.device.messages = [packet(sequence=1, tx=1, rx=0)]
        self.runtime.receive()
        self.assertEqual(self.output[-1], {"type": "result", "id": 1, "ok": False})

    def test_outstanding_transmits_are_bounded(self):
        self.runtime.start()
        for command_id in range(1, 18):
            self.runtime.command({"id": command_id, "command": "wake"})
        self.assertEqual(len(self.runtime.pending), 16)
        self.assertEqual(len(self.device.transmitted()), 16)
        self.assertEqual(self.output[-1], {"type": "result", "id": 17, "ok": False})

    def test_busy_transmit_fails_without_queueing(self):
        self.runtime.start()
        self.device.tx_error = cec.CecError("busy")
        self.runtime.command({"id": 3, "command": "wake"})
        self.assertFalse(self.runtime.pending)
        self.assertEqual(self.output[-1], {"type": "result", "id": 3, "ok": False})

    def test_interrupted_transmit_fails_without_replay(self):
        self.runtime.start()
        self.device.tx_error = InterruptedError(errno.EINTR, "interrupted")
        self.runtime.command({"id": 3, "command": "wake"})
        self.assertFalse(self.runtime.pending)
        self.assertEqual(self.output[-1], {"type": "result", "id": 3, "ok": False})

    def test_command_without_owned_registration_never_transmits(self):
        self.error("no-logical-address", lambda: self.runtime.command({"id": 1, "command": "wake"}))
        self.assertFalse(self.device.transmitted())

    def test_commands_fail_after_physical_change_or_registration_loss(self):
        self.runtime.start()
        self.device.physical = 0x1300
        self.error("disconnected", lambda: self.runtime.command({"id": 1, "command": "wake"}))
        self.device.physical = 0x1200
        self.device.addresses.log_addr_mask = 0
        self.error("no-logical-address", lambda: self.runtime.command({"id": 2, "command": "active-source"}))
        self.assertEqual(self.device.transmitted(), [])
        self.assertEqual(self.output[-2:], [
            {"type": "result", "id": 1, "ok": False}, {"type": "result", "id": 2, "ok": False}])

    def test_state_changes_invalidate_lost_registration_or_edid(self):
        self.runtime.start()
        for event, code in ((state(physical=0xFFFF), "no-physical-address"),
                            (state(physical=0x2000), "disconnected"),
                            (state(mask=0), "no-logical-address")):
            self.device.events = [event]
            self.error(code, self.runtime.drain_events)

    def test_connector_removal_invalidates_registration(self):
        self.device.caps.capabilities |= cec.CEC_CAP_CONNECTOR_INFO
        self.runtime.start()
        self.device.events = [state(connector=0)]
        self.error("disconnected", self.runtime.drain_events)

    def test_lost_messages_reset_input_and_pending_commands(self):
        self.runtime.start()
        self.runtime.command({"id": 1, "command": "wake"})
        self.device.events = [lost()]
        self.runtime.drain_events()
        self.assertEqual(self.output[-2:], [
            {"type": "result", "id": 1, "ok": False}, {"type": "reset", "reason": "messages-lost"}])
        self.assertFalse(self.runtime.pending)

    def test_dropped_events_require_reconnection_even_with_same_state(self):
        self.runtime.start()
        self.device.events = [state(flags=cec.CEC_EVENT_FL_DROPPED_EVENTS)]
        self.error("disconnected", self.runtime.drain_events)
        self.assertEqual(self.output[-1], {"type": "reset", "reason": "messages-lost"})

    def test_startup_event_loss_is_retryable_without_a_pre_ready_reset(self):
        for event in (lost(), state(flags=cec.CEC_EVENT_FL_DROPPED_EVENTS),
                      lost(flags=cec.CEC_EVENT_FL_DROPPED_EVENTS)):
            self.device.events = [event]
            self.error("disconnected", self.runtime.start)
            self.assertEqual(self.output, [])
            self.assertFalse(self.device.transmitted())

    def test_event_loss_during_address_claim_never_emits_reset_before_ready(self):
        self.device.claim_immediately = False
        self.poller.on_poll = lambda: self.device.events.append(lost())
        self.error("disconnected", self.runtime.start)
        self.assertEqual(self.output, [])
        self.assertTrue(self.runtime.owns_registration)
        self.runtime.close()
        self.assertEqual(self.device.addresses.num_log_addrs, 0)
        self.assertFalse(self.device.transmitted())

    def test_same_state_reset_never_sends_source_or_power(self):
        self.runtime.start()
        self.device.events = [state()]
        self.runtime.drain_events()
        self.assertEqual(self.output[-1], {"type": "reset", "reason": "routing-change"})
        self.assertFalse(self.device.transmitted())

    def test_invalid_commands_cannot_transmit(self):
        self.runtime.start()
        invalid = [None, [], {}, True, {"id": True, "command": "wake"},
                   {"id": 0, "command": "wake"}, {"id": -1, "command": "wake"},
                   {"id": 1.0, "command": "wake"}, {"id": 2**53, "command": "wake"},
                   {"id": 1, "command": "standby"}, {"id": 1, "command": "wake", "message": [0x36]},
                   {"id": 1, "command": ["wake"]}]
        for command in invalid:
            with self.subTest(command=command):
                self.error("protocol", lambda: self.runtime.command(command))
        self.assertFalse(self.device.transmitted())

    def test_duplicate_pending_command_id_is_rejected(self):
        self.runtime.start()
        self.runtime.command({"id": 1, "command": "wake"})
        self.error("protocol", lambda: self.runtime.command({"id": 1, "command": "active-source"}))
        self.assertEqual(len(self.device.transmitted()), 1)

    def test_streaming_lines_and_line_limits(self):
        self.runtime.start()
        self.runtime.feed(b'{"id":1,"command":')
        self.assertFalse(self.device.transmitted())
        self.runtime.feed(b'"wake"}\n{"id":2,"command":"active-source"}\n')
        self.assertEqual(len(self.device.transmitted()), 2)
        self.error("protocol", lambda: self.runtime.feed(b"x" * 1025))

    def test_malformed_json_utf8_duplicates_constants_and_long_lines(self):
        self.runtime.start()
        for line in (b"\n", b"\xff\n", b"[]\n", b"NaN\n", b"x" * 1025 + b"\n",
                     b'{"id":1,"id":2,"command":"wake"}\n',
                     b'{"id":NaN,"command":"wake"}\n',
                     b'{"id":1,"command":"wake","command":"active-source"}\n'):
            with self.subTest(line=line[:30]):
                self.runtime.input_buffer.clear()
                self.error("protocol", lambda: self.runtime.feed(line))
        self.assertFalse(self.device.transmitted())

    def test_device_errors_in_poll_exit_without_spinning(self):
        for mask in (cec.POLLERR, cec.POLLHUP, cec.POLLNVAL):
            self.poller.responses = [[(self.device.fd, mask)]]
            self.error("disconnected", lambda: self.runtime._poll(self.poller, 100))
        self.assertEqual(len(self.poller.timeouts), 3)

    def test_poll_eintr_is_benign(self):
        self.poller.responses = [InterruptedError(errno.EINTR, "interrupted")]
        self.assertEqual(self.runtime._poll(self.poller, 100), [])

    def test_read_only_probe_queries_without_any_configuration_or_transmit(self):
        self.device.addresses.num_log_addrs = 1
        self.device.addresses.log_addr[0] = 8
        self.device.addresses.log_addr_mask = 1 << 8
        self.device.addresses.flags = 2
        result = cec.probe_device(self.device, "/dev/cec1")
        self.assertEqual(result, {
            "type": "probe", "device": "/dev/cec1", "capabilities": 6,
            "availableLogicalAddresses": 1, "physicalAddress": 0x1200,
            "logicalAddresses": [8], "logicalAddressMask": 256,
            "flags": 2, "configured": True})
        self.assertEqual([request for request, _ in self.device.calls],
                         [cec.CEC_ADAP_G_CAPS, cec.CEC_ADAP_G_PHYS_ADDR, cec.CEC_ADAP_G_LOG_ADDRS])

    def test_probe_reports_missing_edid_without_claiming_anything(self):
        self.device.physical = 0xFFFF
        result = cec.probe_device(self.device, "/dev/cec0")
        self.assertEqual(result["physicalAddress"], 0xFFFF)
        self.assertFalse(result["configured"])
        self.assertFalse(self.device.registrations())

    def test_run_eof_closes_without_any_user_action(self):
        self.poller.responses = [[(0, cec.POLLHUP)]]
        self.runtime.run(0, read=lambda _fd, _size: b"")
        self.runtime.close()
        self.assertFalse(self.device.transmitted())
        self.assertTrue(self.device.closed)

    def test_state_events_are_processed_before_stdin_in_same_poll(self):
        def disconnect():
            self.device.events.append(state(mask=0))
        self.poller.on_poll = disconnect
        self.poller.responses = [[(0, cec.POLLIN), (self.device.fd, cec.POLLPRI)]]
        self.error("no-logical-address", lambda: self.runtime.run(
            0, read=lambda _fd, _size: b'{"id":1,"command":"wake"}\n'))
        self.assertFalse(self.device.transmitted())

    def test_run_handles_receive_and_eof_with_poll_fixtures(self):
        self.device.messages = [packet()]
        self.poller.responses = [[(self.device.fd, cec.POLLIN)], [(0, cec.POLLHUP)]]
        self.runtime.run(0, read=lambda _fd, _size: b"")
        self.assertEqual([value["type"] for value in self.output], ["ready", "packet"])
        self.assertTrue(all(not mask & 4 for _, mask in self.poller.registered))

    def test_signal_stop_during_registration_never_claims(self):
        self.stopping = True
        with self.assertRaises(cec.Stopped):
            self.runtime.start()
        self.assertFalse(self.device.registrations())

    def test_signal_stop_during_poll_exits_and_releases_own_registration(self):
        def stop():
            self.stopping = True
        self.poller.on_poll = stop
        self.runtime.run(0)
        self.runtime.close()
        self.assertTrue(self.device.closed)
        self.assertFalse(self.device.transmitted())

    def test_sigterm_with_pending_stdin_does_not_read_or_transmit_command(self):
        def stop():
            self.stopping = True
        def forbidden_read(_fd, _size):
            self.fail("stdin must not be read after SIGTERM")
        self.poller.on_poll = stop
        self.poller.responses = [[(0, cec.POLLIN)]]
        self.runtime.run(0, read=forbidden_read)
        self.runtime.close()
        self.assertFalse(self.device.transmitted())
        self.assertEqual(self.device.addresses.num_log_addrs, 0)

    def test_command_after_sigterm_is_rejected_even_if_stdin_was_already_read(self):
        self.runtime.start()
        self.stopping = True
        with self.assertRaises(cec.Stopped):
            self.runtime.feed(b'{"id":1,"command":"wake"}\n')
        self.assertFalse(self.device.transmitted())


class RoutingTests(unittest.TestCase):
    error = RuntimeTests.error

    def setUp(self):
        RuntimeTests.setUp(self)
        latest = None
        def emit(event):
            nonlocal latest
            if event["type"] == "routing":
                self.assertEqual(set(event), {
                    "type", "id", "opcode", "source", "target",
                    "physicalAddress", "decision", "acknowledgement",
                })
                if latest is not None:
                    self.assertGreaterEqual(event["id"], latest["id"])
                    if event["id"] == latest["id"]:
                        self.assertEqual({**event, "acknowledgement": None},
                                         {**latest, "acknowledgement": None})
                latest = dict(event)
            self.output.append(event)
        self.runtime.emit = emit

    def routes(self):
        return [event for event in self.output if event["type"] == "routing"]

    def request(self, payload=(0x0F, 0x86, 0x12, 0x00), **statuses):
        self.device.messages.append(packet(payload, **statuses))
        return self.runtime.receive()

    def test_exact_tv_path_only_queues_until_owner_dispatches(self):
        self.runtime.start()
        self.assertTrue(self.request())
        self.assertFalse(self.device.transmitted())
        expected = {
            "type": "routing", "id": 1, "opcode": 0x86, "source": 0, "target": 15,
            "physicalAddress": 0x1200, "decision": "matched", "acknowledgement": "pending",
        }
        self.assertEqual(self.routes(), [expected])
        self.runtime.dispatch_route()
        transmitted, = self.device.transmitted()
        self.assertEqual(list(transmitted.msg[:transmitted.len]), [0x4F, 0x82, 0x12, 0])
        self.assertEqual((transmitted.timeout, transmitted.reply, transmitted.flags), (0, 0, 0))
        self.device.messages.append(packet(sequence=1, tx=1, rx=0))
        self.runtime.receive()
        self.assertEqual(self.routes(), [expected, {**expected, "acknowledgement": "sent"}])
        self.assertFalse(any(event["type"] == "result" for event in self.output))

    def test_each_registered_playback_address_uses_current_edid_not_a_fixed_path(self):
        for address in (4, 8, 11):
            with self.subTest(address=address):
                device, output = FakeDevice(), []
                device.claim_address = address
                device.physical = 0x2310
                device.events = [state(physical=0x2310, mask=0)]
                original_claim = device.claim
                def claim():
                    original_claim()
                    device.events[-1].state_change.phys_addr = 0x2310
                device.claim = claim
                runtime = cec.Runtime(device, output.append, poll_factory=lambda: self.poller,
                                      clock=self.clock)
                try:
                    runtime.start()
                    device.messages.append(packet((0x0F, 0x86, 0x23, 0x10)))
                    runtime.receive()
                    runtime.dispatch_route()
                    tx, = device.transmitted()
                    self.assertEqual(list(tx.msg[:tx.len]), [(address << 4) | 15, 0x82, 0x23, 0x10])
                finally:
                    runtime.close()

    def test_rejected_set_stream_path_diagnostics_have_exact_bounded_schema(self):
        self.runtime.start()
        examples = [
            ((0x4F, 0x86, 0x12, 0), "wrong-source", 0x1200),
            ((0xFF, 0x86, 0x12, 0), "wrong-source", 0x1200),
            ((0x04, 0x86, 0x12, 0), "wrong-target", 0x1200),
            ((0x0F, 0x86), "wrong-length", None),
            ((0x0F, 0x86, 0x12), "wrong-length", None),
            ((0x0F, 0x86, 0x12, 0, 0), "wrong-length", None),
            ((0x0F, 0x86, 0x10, 0), "wrong-path", 0x1000),
            ((0x0F, 0x86, 0x12, 0x10), "wrong-path", 0x1210),
            ((0x0F, 0x86, 0x10, 0x20), "wrong-path", 0x1020),
            ((0x0F, 0x86, 0xFF, 0xFF), "wrong-path", 0xFFFF),
            ((0x0F, 0x86, 0, 0), "wrong-path", 0),
        ]
        for index, (payload, decision, physical) in enumerate(examples, 1):
            with self.subTest(payload=payload):
                self.request(payload)
                self.runtime.dispatch_route()
                self.assertEqual(self.routes()[-1], {
                    "type": "routing", "id": index, "opcode": 0x86,
                    "source": payload[0] >> 4, "target": payload[0] & 15,
                    "physicalAddress": physical, "decision": decision, "acknowledgement": "none",
                })
        self.assertFalse(self.device.transmitted())
        self.assertEqual(self.runtime.routing, self.routes()[-1])

    def test_nonrouting_packets_and_invalid_statuses_never_authorize_or_diagnose(self):
        self.runtime.start()
        for sequence in (0, 1, 99):
            for tx in (0, 1, 0x80):
                for rx in (0, 1, 3, 8):
                    if (sequence, tx, rx) == (0, 0, 1):
                        continue
                    self.request(sequence=sequence, tx=tx, rx=rx)
                    self.runtime.dispatch_route()
        self.request((0x04, 0x44, 1))
        self.request((0x04, 0x45))
        self.request((0x0F,))
        self.request((0x0F, 0x85))
        self.assertEqual(self.routes(), [])
        self.assertFalse(self.device.transmitted())

    def test_other_routing_opcodes_are_diagnostic_only(self):
        self.runtime.start()
        for payload, physical, decision in (
                ((0x0F, 0x80, 0x12, 0, 0x20, 0), 0x2000, "route-away"),
                ((0x0F, 0x81, 0x12, 0), 0x1200, "observed"),
                ((0x8F, 0x82, 0x20, 0), 0x2000, "route-away"),
                ((0x4F, 0x82, 0x12, 0), 0x1200, "observed"),
                ((0x0F, 0x36), None, "route-away"),
                ((0x40, 0x9D, 0x12, 0), 0x1200, "route-away")):
            self.request(payload)
            self.runtime.dispatch_route()
            self.assertEqual(self.routes()[-1]["decision"], decision)
            self.assertEqual(self.routes()[-1]["physicalAddress"], physical)
            self.assertEqual(self.routes()[-1]["acknowledgement"], "none")
        self.assertFalse(self.device.transmitted())

    def test_inactive_and_directed_away_routes_emit_one_explicit_remote_reset(self):
        self.runtime.start()
        for payload in ((0x40, 0x9D, 0x12, 0), (0x80, 0x9D, 0x20, 0),
                        (0x8F, 0x9D, 0x20, 0), (0x50, 0x36),
                        (0x80, 0x82, 0x20, 0), (0x80, 0x81, 0x20, 0),
                        (0x80, 0x80, 0x12, 0, 0x20, 0)):
            with self.subTest(payload=payload):
                self.output.clear()
                self.request(payload)
                self.assertEqual([event for event in self.output if event["type"] == "reset"],
                                 [{"type": "reset", "reason": "routing-change"}])
                self.assertEqual([event["type"] for event in self.output],
                                 ["routing", "reset", "packet"])
        self.assertFalse(self.device.transmitted())

    def test_normalizer_covered_routes_do_not_duplicate_remote_reset(self):
        self.runtime.start()
        for payload in ((0x0F, 0x36), (0x54, 0x36), (0x8F, 0x82, 0x20, 0),
                        (0x84, 0x81, 0x20, 0), (0x0F, 0x86, 0x20, 0),
                        (0x0F, 0x80, 0x12, 0, 0x20, 0)):
            self.request(payload)
        self.assertFalse(any(event["type"] == "reset" for event in self.output))

    def test_malformed_or_invalid_status_inactive_source_never_resets_input(self):
        self.runtime.start()
        for payload in ((0x80, 0x9D), (0x80, 0x9D, 0x12),
                        (0x80, 0x9D, 0x12, 0, 0), (0xF0, 0x9D, 0x12, 0)):
            self.request(payload)
        for statuses in ({"sequence": 1}, {"tx": 1}, {"rx": 0}, {"rx": 3}):
            self.request((0x80, 0x9D, 0x12, 0), **statuses)
        self.assertFalse(any(event["type"] == "reset" for event in self.output))
        self.assertFalse(self.device.transmitted())

    def test_request_active_source_is_ignored_even_with_pending_exact_ack(self):
        self.runtime.start()
        self.request()
        routing = self.routes()[-1]
        self.request((0x0F, 0x85))
        self.assertEqual(self.routes(), [routing])
        self.runtime.dispatch_route()
        self.assertEqual(len(self.device.transmitted()), 1)

    def test_readiness_and_owned_registration_are_required(self):
        self.request()
        self.assertEqual(self.routes()[-1]["decision"], "invalid-registration")
        self.runtime.start()
        for field, value in (("ready", False), ("owns_registration", False), ("logical", 15),
                             ("physical", 0x1020), ("physical", None), ("closed", True)):
            previous = getattr(self.runtime, field)
            setattr(self.runtime, field, value)
            self.request()
            self.runtime.dispatch_route()
            self.assertEqual(self.routes()[-1]["decision"], "invalid-registration")
            setattr(self.runtime, field, previous)
        self.assertFalse(self.device.transmitted())

    def test_registration_is_revalidated_at_actual_transmit(self):
        for mutation, code in (
                (lambda: setattr(self.device, "physical", 0x1300), "disconnected"),
                (lambda: setattr(self.device, "physical", 0xFFFF), "no-physical-address"),
                (lambda: setattr(self.device.addresses, "log_addr_mask", 0), "no-logical-address"),
                (lambda: setattr(self.device.addresses, "flags", 2), "unsupported"),
                (lambda: setattr(self.device, "mode", 1), "unsupported")):
            with self.subTest(code=code):
                self.device.physical = 0x1200
                self.device.addresses.flags = 0
                self.device.mode = cec.EXCLUSIVE_MODE
                if not self.runtime.ready:
                    self.runtime.start()
                self.device.addresses.log_addr_mask = 16
                self.clock.now += cec.ROUTE_COOLDOWN
                self.request()
                mutation()
                self.error(code, self.runtime.dispatch_route)
                self.assertEqual(self.routes()[-1]["decision"], "matched")
                self.assertEqual(self.routes()[-1]["acknowledgement"], "cancelled")
        self.assertFalse(self.device.transmitted())

    def test_route_away_arriving_after_receive_is_drained_before_write(self):
        self.runtime.start()
        self.request()
        self.device.messages.append(packet((0x0F, 0x86, 0x20, 0)))
        self.runtime.dispatch_route()
        self.assertFalse(self.device.transmitted())
        self.assertEqual(self.routes()[-1]["decision"], "wrong-path")

    def test_any_competing_route_standby_or_inactive_cancels_batch_authorization(self):
        self.runtime.start()
        for payload in ((0x0F, 0x80, 0x12, 0, 0x20, 0), (0x0F, 0x81, 0x20, 0),
                        (0x8F, 0x82, 0x12, 0), (0x0F, 0x36), (0x40, 0x9D, 0x12, 0)):
            self.clock.now += 3
            self.device.messages = [packet((0x0F, 0x86, 0x12, 0)), packet(payload),
                                    packet((0x0F, 0x86, 0x12, 0))]
            self.runtime.receive()
            self.runtime.dispatch_route()
            self.assertEqual(self.routes()[-1]["acknowledgement"], "suppressed")
        self.assertFalse(self.device.transmitted())

    def test_receive_batch_bound_never_replays_request_before_later_route_away(self):
        self.runtime.start()
        self.device.messages = ([packet((0x0F, 0x86, 0x12, 0))] +
                                [packet()] * 130 + [packet((0x0F, 0x86, 0x20, 0))])
        self.assertFalse(self.runtime.receive())
        self.runtime.dispatch_route()
        self.assertEqual(self.routes()[-1]["acknowledgement"], "suppressed")
        self.assertFalse(self.runtime.receive())
        self.runtime.dispatch_route()
        self.assertTrue(self.runtime.receive())
        self.runtime.dispatch_route()
        self.assertFalse(self.device.transmitted())
        self.clock.now += 3
        self.request()
        self.runtime.dispatch_route()
        self.assertEqual(len(self.device.transmitted()), 1)

    def test_candidate_arriving_in_later_bounded_batch_is_also_suppressed(self):
        self.runtime.start()
        self.device.messages = [packet()] * 64 + [packet((0x0F, 0x86, 0x12, 0))]
        self.assertFalse(self.runtime.receive())
        self.assertTrue(self.runtime.receive())
        self.runtime.dispatch_route()
        self.assertEqual(self.routes()[-1]["acknowledgement"], "suppressed")
        self.assertFalse(self.device.transmitted())

    def test_dispatch_receive_bound_and_eintr_never_count_as_eagain(self):
        self.runtime.start()
        self.request()
        self.device.messages = [packet()] * 64
        self.runtime.dispatch_route()
        self.assertFalse(self.device.transmitted())
        self.runtime.receive()
        self.clock.now += 3
        self.request()
        original = self.device.ioctl
        def interrupted(request, value):
            if request == cec.CEC_RECEIVE:
                raise InterruptedError(errno.EINTR, "interrupted")
            return original(request, value)
        with patch.object(self.device, "ioctl", side_effect=interrupted):
            self.runtime.dispatch_route()
        self.assertFalse(self.device.transmitted())
        self.assertEqual(self.routes()[-1]["acknowledgement"], "suppressed")

    def test_state_event_and_lost_message_reset_cancel_before_write(self):
        self.runtime.start()
        for event in (state(), lost()):
            self.clock.now += 3
            self.request()
            self.device.events.append(event)
            self.runtime.dispatch_route()
            self.assertIsNone(self.runtime.route_candidate)
            self.assertEqual(self.routes()[-1]["acknowledgement"], "cancelled")
        self.assertFalse(self.device.transmitted())

    def test_state_event_during_receive_is_processed_before_write(self):
        self.runtime.start()
        self.request()
        original = self.device.ioctl
        def state_after_receive(request, value):
            if request == cec.CEC_RECEIVE:
                self.device.events.append(state())
            return original(request, value)
        with patch.object(self.device, "ioctl", side_effect=state_after_receive):
            self.runtime.dispatch_route()
        self.assertFalse(self.device.transmitted())

    def test_state_queue_bound_suppresses_instead_of_treating_it_as_drained(self):
        self.runtime.start()
        self.request()
        self.device.events = [state()] * 65
        self.runtime.dispatch_route()
        self.assertEqual(len(self.device.events), 1)
        self.assertFalse(self.device.transmitted())
        self.runtime.drain_events()
        self.runtime.dispatch_route()
        self.assertFalse(self.device.transmitted())

    def test_disconnect_and_signal_cancel_without_reconnect_or_replay(self):
        self.runtime.start()
        self.request()
        self.poller.responses = [[(self.device.fd, cec.POLLHUP)]]
        self.error("disconnected", lambda: self.runtime._poll(self.poller, 0))
        self.runtime.dispatch_route()
        self.clock.now += 3
        self.request()
        self.stopping = True
        with self.assertRaises(cec.Stopped):
            self.runtime.dispatch_route()
        self.stopping = False
        self.runtime.close()
        self.device.reopen()
        other = cec.Runtime(self.device, self.output.append, poll_factory=lambda: self.poller)
        try:
            other.start()
            other.dispatch_route()
            self.assertFalse(self.device.transmitted())
        finally:
            other.close()

    def test_duplicate_burst_coalesces_and_sliding_monotonic_cooldown_has_no_timer_replay(self):
        self.runtime.start()
        self.device.messages = [packet((0x0F, 0x86, 0x12, 0))] * 20
        self.runtime.receive()
        self.runtime.dispatch_route()
        self.assertEqual(len(self.device.transmitted()), 1)
        self.device.messages = [packet(sequence=1, tx=1, rx=0)]
        self.runtime.receive()
        for _ in range(10):
            self.clock.now += 1
            self.request()
            self.runtime.dispatch_route()
            self.assertEqual(self.routes()[-1]["acknowledgement"], "suppressed")
        self.clock.now += 100
        self.runtime.expire_commands()
        self.runtime.dispatch_route()
        self.assertEqual(len(self.device.transmitted()), 1)
        self.request()
        self.runtime.dispatch_route()
        self.assertEqual(len(self.device.transmitted()), 2)

    def test_large_duplicate_burst_transmits_nothing(self):
        self.runtime.start()
        self.device.messages = [packet((0x0F, 0x86, 0x12, 0))] * 200
        while self.device.messages:
            self.runtime.receive()
            self.runtime.dispatch_route()
        self.assertFalse(self.device.transmitted())
        self.assertIsNone(self.runtime.route_candidate)
        self.assertFalse(self.runtime.pending)

    def test_manual_command_cancels_candidate_and_pending_ui_command_suppresses_new_request(self):
        self.runtime.start()
        self.request()
        self.runtime.command({"id": 1, "command": "wake"})
        self.runtime.dispatch_route()
        self.clock.now += 3
        self.request()
        self.runtime.dispatch_route()
        self.assertEqual(len(self.device.transmitted()), 1)
        self.assertEqual(self.routes()[-1]["acknowledgement"], "suppressed")
        self.device.messages.append(packet(sequence=1, tx=1, rx=0))
        self.runtime.receive()
        self.assertEqual(self.output[-1], {"type": "result", "id": 1, "ok": True})
        self.runtime.dispatch_route()
        self.assertEqual(len(self.device.transmitted()), 1)

    def test_partial_stdin_and_late_readability_suppress_candidate(self):
        self.runtime.start()
        self.runtime.feed(b'{"id":1,')
        self.request()
        self.runtime.dispatch_route()
        self.assertEqual(self.routes()[-1]["acknowledgement"], "suppressed")
        self.runtime.input_buffer.clear()
        self.clock.now += 3
        self.request()
        self.runtime.dispatch_route(stdin_pending=lambda: True)
        self.assertFalse(self.device.transmitted())
        self.assertEqual(self.routes()[-1]["acknowledgement"], "suppressed")

    def test_manual_completion_earlier_in_receive_batch_does_not_enable_ack(self):
        self.runtime.start()
        self.runtime.command({"id": 1, "command": "active-source"})
        self.runtime.receive()
        self.device.messages = [packet(sequence=1, tx=1, rx=0),
                                packet((0x0F, 0x86, 0x12, 0))]
        self.runtime.receive()
        self.runtime.dispatch_route()
        self.assertEqual(self.routes()[-1]["acknowledgement"], "suppressed")
        self.assertEqual(len(self.device.transmitted()), 1)

    def test_registration_changed_at_final_input_guard_is_revalidated(self):
        self.runtime.start()
        self.request()
        def change_registration():
            self.device.addresses.log_addr[0] = 8
            self.device.addresses.log_addr_mask = 1 << 8
            return False
        self.error("no-logical-address", lambda: self.runtime.dispatch_route(change_registration))
        self.assertFalse(self.device.transmitted())
        self.assertEqual(self.routes()[-1]["decision"], "matched")
        self.assertEqual(self.routes()[-1]["acknowledgement"], "cancelled")

    def test_reset_before_receive_suppresses_buffered_matching_request(self):
        self.runtime.start()
        self.device.events.append(state())
        self.runtime.drain_events()
        self.request()
        self.runtime.dispatch_route()
        self.assertFalse(self.device.transmitted())
        self.assertEqual(self.routes()[-1]["acknowledgement"], "suppressed")

    def test_route_or_stdin_arriving_during_registration_cancels_before_transmit(self):
        self.runtime.start()
        for mask, fd in ((cec.POLLIN, self.device.fd), (cec.POLLPRI, self.device.fd),
                         (cec.POLLIN, 0)):
            with self.subTest(mask=mask, fd=fd):
                self.clock.now += 3
                self.request()
                original = self.device.ioctl
                def arriving(request, value):
                    result = original(request, value)
                    if request == cec.CEC_G_MODE:
                        self.poller.responses.append([(fd, mask)])
                    return result
                def input_pending():
                    return bool(self.runtime._poll(self.poller, 0))
                with patch.object(self.device, "ioctl", side_effect=arriving):
                    self.runtime.dispatch_route(input_pending)
                self.assertEqual(self.routes()[-1]["acknowledgement"], "suppressed")
                self.assertFalse(self.device.transmitted())

    def test_interrupted_final_readiness_probe_cannot_authorize_transmit(self):
        self.runtime.start()
        self.request()
        self.poller.responses = [[], InterruptedError(errno.EINTR, "interrupted")]
        self.runtime.dispatch_route(lambda: bool(self.runtime._poll(self.poller, 0)))
        self.assertEqual(self.routes()[-1]["acknowledgement"], "suppressed")
        self.assertFalse(self.device.transmitted())

    def test_run_loop_only_dispatches_after_draining_and_stdin_guard(self):
        self.device.messages.append(packet((0x0F, 0x86, 0x12, 0)))
        self.poller.responses = [[(self.device.fd, cec.POLLIN)], [], [], [(0, cec.POLLHUP)]]
        self.runtime.run(0, read=lambda _fd, _size: b"")
        self.assertEqual(len(self.device.transmitted()), 1)
        self.assertEqual(self.poller.timeouts, [100, 0, 0, 100])

    def test_run_loop_same_poll_manual_command_wins_even_with_immediate_completion(self):
        self.device.immediate_status = 1
        self.device.messages.append(packet((0x0F, 0x86, 0x12, 0)))
        self.poller.responses = [[(self.device.fd, cec.POLLIN), (0, cec.POLLIN)],
                                 [(0, cec.POLLHUP)]]
        reads = iter([b'{"id":1,"command":"wake"}\n', b""])
        self.runtime.run(0, read=lambda _fd, _size: next(reads))
        tx, = self.device.transmitted()
        self.assertEqual(list(tx.msg[:tx.len]), [0x40, 0x04])
        self.assertEqual(self.routes()[-1]["acknowledgement"], "cancelled")

    def test_run_loop_stdin_becoming_readable_during_drain_wins(self):
        self.device.messages.append(packet((0x0F, 0x86, 0x12, 0)))
        self.poller.responses = [[(self.device.fd, cec.POLLIN)], [(0, cec.POLLIN)],
                                 [(0, cec.POLLIN)], [(0, cec.POLLHUP)]]
        reads = iter([b'{"id":1,"command":"wake"}\n', b""])
        self.runtime.run(0, read=lambda _fd, _size: next(reads))
        tx, = self.device.transmitted()
        self.assertEqual(list(tx.msg[:tx.len]), [0x40, 0x04])
        self.assertEqual(self.routes()[-1]["acknowledgement"], "suppressed")

    def test_run_loop_new_device_readiness_at_final_guard_suppresses(self):
        for mask in (cec.POLLIN, cec.POLLPRI):
            with self.subTest(mask=mask):
                self.runtime.start = lambda: None
                if not self.runtime.ready:
                    cec.Runtime.start(self.runtime)
                self.clock.now += 3
                self.device.messages.append(packet((0x0F, 0x86, 0x12, 0)))
                self.poller.responses = [[(self.device.fd, cec.POLLIN)],
                                         [(self.device.fd, mask)], [(0, cec.POLLHUP)]]
                self.runtime.run(0, read=lambda _fd, _size: b"")
                self.assertEqual(self.routes()[-1]["acknowledgement"], "suppressed")
                self.assertFalse(self.device.transmitted())

    def test_run_loop_large_receive_batch_never_sends_before_later_route_away(self):
        self.device.messages = ([packet((0x0F, 0x86, 0x12, 0))] + [packet()] * 128 +
                                [packet((0x0F, 0x86, 0x20, 0))])
        self.poller.responses = [[(self.device.fd, cec.POLLIN)]] * 3 + [[(0, cec.POLLHUP)]]
        self.runtime.run(0, read=lambda _fd, _size: b"")
        self.assertFalse(self.device.transmitted())
        self.assertEqual(self.routes()[-1]["decision"], "wrong-path")

    def test_failed_and_timed_out_acknowledgements_are_not_retried(self):
        self.runtime.start()
        for error in (cec.CecError("busy"), BlockingIOError(errno.EAGAIN, "busy"),
                      InterruptedError(errno.EINTR, "interrupted")):
            self.clock.now += 3
            self.request()
            self.device.tx_error = error
            self.runtime.dispatch_route()
            self.assertEqual(self.routes()[-1]["acknowledgement"], "failed")
            self.assertFalse(self.runtime.pending)
        self.device.tx_error = None
        self.clock.now += 3
        self.request()
        self.runtime.dispatch_route()
        self.clock.now += cec.TX_TIMEOUT
        self.runtime.expire_commands()
        self.assertEqual(self.routes()[-1]["acknowledgement"], "failed")
        routes = list(self.routes())
        self.device.messages.append(packet(sequence=1, tx=1, rx=0))
        self.runtime.receive()
        self.runtime.dispatch_route()
        self.assertEqual(self.routes(), routes)
        self.assertEqual(len(self.device.kernel_transmits), 1)

    def test_completion_verification_uses_existing_status_and_sequence_rules(self):
        self.runtime.start()
        self.request()
        self.runtime.dispatch_route()
        self.device.messages = [packet(sequence=1, tx=1, rx=1),
                                packet(sequence=99, tx=1, rx=0),
                                packet(sequence=1, tx=0, rx=1)]
        self.runtime.receive()
        self.assertEqual(self.routes()[-1]["acknowledgement"], "pending")
        self.device.messages = [packet(sequence=1, tx=0x21, rx=0)]
        self.runtime.receive()
        self.assertEqual(self.routes()[-1]["acknowledgement"], "failed")
        self.assertFalse(self.runtime.pending)

    def test_outstanding_ack_blocks_fresh_request_even_after_cooldown(self):
        self.runtime.start()
        self.request()
        self.runtime.dispatch_route()
        self.clock.now += 3
        self.request()
        self.runtime.dispatch_route()
        self.assertEqual(self.routes()[-1]["acknowledgement"], "suppressed")
        self.assertEqual(len(self.device.transmitted()), 1)
        latest = self.routes()[-1]
        self.device.messages.append(packet(sequence=1, tx=1, rx=0))
        self.runtime.receive()
        self.assertEqual(self.routes()[-1], latest)

    def test_immediate_completion_and_late_async_completion(self):
        self.runtime.start()
        self.device.immediate_status = 1
        self.request()
        self.runtime.dispatch_route()
        self.assertEqual(self.routes()[-1]["acknowledgement"], "sent")
        self.device.immediate_status = 0
        self.clock.now += 3
        self.request()
        self.runtime.dispatch_route()
        self.clock.now += cec.TX_TIMEOUT
        self.device.messages = [packet(sequence=2, tx=1, rx=0)]
        self.runtime.receive()
        self.assertEqual(self.routes()[-1]["acknowledgement"], "failed")

    def test_newer_route_diagnostic_is_not_overwritten_by_old_completion_or_self_echo(self):
        self.runtime.start()
        self.request()
        self.runtime.dispatch_route()
        self.request((0x0F, 0x86, 0x20, 0))
        latest = self.routes()[-1]
        self.device.messages = [packet((0x4F, 0x82, 0x12, 0), sequence=1, tx=1, rx=0)]
        self.runtime.receive()
        self.assertEqual(self.routes()[-1], latest)
        self.assertEqual(self.runtime.routing, latest)
        self.request((0x4F, 0x82, 0x12, 0))
        self.runtime.dispatch_route()
        self.assertEqual(self.routes()[-1]["decision"], "observed")
        self.assertEqual(len(self.device.transmitted()), 1)

    def test_manual_and_internal_completion_ids_cannot_collide(self):
        self.runtime.start()
        self.request()
        self.runtime.dispatch_route()
        self.runtime.command({"id": 1, "command": "wake"})
        self.device.messages = [packet(sequence=1, tx=1, rx=0), packet(sequence=2, tx=1, rx=0)]
        self.runtime.receive()
        self.assertEqual([event for event in self.output if event["type"] == "result"],
                         [{"type": "result", "id": 1, "ok": True}])
        self.assertFalse(self.runtime.pending)

    def test_routing_event_id_exhaustion_fails_closed_without_unbounded_integer(self):
        self.runtime.start()
        self.runtime.routing_id = cec.MAX_EVENT_ID - 1
        self.request()
        self.assertEqual(self.routes()[-1]["id"], cec.MAX_EVENT_ID)
        self.error("protocol", self.request)
        self.assertEqual(self.runtime.routing_id, cec.MAX_EVENT_ID)
        self.assertIsNone(self.runtime.route_candidate)
        self.assertFalse(self.device.transmitted())

    def test_no_new_stdin_command_or_raw_transmit_api(self):
        self.runtime.start()
        for command in ("route", "acknowledge", "set-stream-path", "transmit", "raw"):
            self.error("protocol", lambda: self.runtime.command({"id": 1, "command": command}))
        self.error("protocol", lambda: self.runtime.command({
            "id": 1, "command": "active-source", "authorization": True}))
        self.assertFalse(self.device.transmitted())


class DeviceTests(unittest.TestCase):
    def test_only_proven_64_bit_linux_architectures_can_open_device(self):
        for machine in ("armv6l", "armv7l", "armv8l", "i386", "i686", "ppc64", "mips64"):
            with self.subTest(machine=machine), \
                    patch.object(sys, "platform", "linux"), \
                    patch.object(cec, "fcntl", SimpleNamespace()), \
                    patch.object(cec.platform, "machine", return_value=machine), \
                    patch.object(cec, "open_device") as opener:
                with self.assertRaises(cec.CecError) as caught:
                    cec.Device("/dev/cec0")
                self.assertEqual(caught.exception.code, "unsupported")
                opener.assert_not_called()
        for machine in ("aarch64", "arm64", "x86_64"):
            with self.subTest(machine=machine), \
                    patch.object(sys, "platform", "linux"), \
                    patch.object(cec, "fcntl", SimpleNamespace()), \
                    patch.object(cec.platform, "machine", return_value=machine), \
                    patch.object(cec, "open_device", return_value=12) as opener:
                self.assertEqual(cec.Device("/dev/cec0").fd, 12)
                opener.assert_called_once_with("/dev/cec0", False)

    def test_32_bit_python_is_rejected_even_on_a_64_bit_kernel(self):
        with patch.object(sys, "platform", "linux"), \
                patch.object(cec, "fcntl", SimpleNamespace()), \
                patch.object(cec.platform, "machine", return_value="aarch64"), \
                patch.object(ctypes, "sizeof", return_value=4), \
                patch.object(cec, "open_device") as opener:
            with self.assertRaises(cec.CecError) as caught:
                cec.Device("/dev/cec0")
            self.assertEqual(caught.exception.code, "unsupported")
            opener.assert_not_called()

    def fake_system(self):
        info = SimpleNamespace(st_mode=stat.S_IFCHR | 0o660, st_dev=1, st_ino=3, st_rdev=4)
        system = SimpleNamespace(O_RDONLY=0, O_RDWR=2, O_NOFOLLOW=0x20000,
                                 O_CLOEXEC=0x80000, O_NONBLOCK=0x800)
        system.flags = []
        system.closed = []
        system.lstat = lambda path: info
        system.fstat = lambda fd: info
        system.open = lambda path, flags: system.flags.append((path, flags)) or 12
        system.close = system.closed.append
        return system

    def test_exact_explicit_device_path_required(self):
        for path in ("/dev/cec0", "/dev/cec1", "/dev/cec123"):
            cec.validate_device_path(path)
        for path in ("cec0", "/dev/cec", "/dev/cec01", "/dev/cec-1", "/dev/../dev/cec0",
                     "/dev/cec0/../cec1", "/dev/cec0\n", "/dev/cec0/child", "/dev/cec0\x00",
                     "/dev/ttyUSB0", " /dev/cec0", None, "/dev/cec\u0661"):
            with self.subTest(path=path), self.assertRaises(cec.CecError):
                cec.validate_device_path(path)

    def test_open_is_nonblocking_nofollow_and_probe_read_only(self):
        for probe, access in ((True, 0), (False, 2)):
            system = self.fake_system()
            self.assertEqual(cec.open_device("/dev/cec1", probe=probe, system=system), 12)
            self.assertEqual(system.flags, [("/dev/cec1", access | 0x20000 | 0x80000 | 0x800)])
            self.assertFalse(system.closed)

    def test_symlink_and_regular_files_are_rejected_before_open(self):
        for mode in (stat.S_IFLNK, stat.S_IFREG, stat.S_IFDIR, stat.S_IFBLK):
            system = self.fake_system()
            system.lstat = lambda _path: SimpleNamespace(st_mode=mode)
            with self.assertRaises(cec.CecError) as caught:
                cec.open_device("/dev/cec0", system=system)
            self.assertEqual(caught.exception.code, "invalid-device")
            self.assertFalse(system.flags)

    def test_path_swap_after_open_is_rejected_and_fd_closed(self):
        system = self.fake_system()
        system.fstat = lambda _fd: SimpleNamespace(st_mode=stat.S_IFCHR, st_dev=1, st_ino=999, st_rdev=4)
        with self.assertRaises(cec.CecError):
            cec.open_device("/dev/cec0", system=system)
        self.assertEqual(system.closed, [12])

    def test_missing_permission_and_symlink_errors_are_sanitized(self):
        for number, code in ((errno.ENOENT, "missing-device"), (errno.EACCES, "permission"),
                             (errno.ELOOP, "invalid-device"), (errno.ENODEV, "missing-device")):
            system = self.fake_system()
            def fail(_path, _flags):
                raise OSError(number, "private diagnostic string")
            system.open = fail
            with self.assertRaises(cec.CecError) as caught:
                cec.open_device("/dev/cec0", system=system)
            self.assertEqual(str(caught.exception), code)

    def test_ioctl_uses_mutable_native_buffer_and_returns_filled_structure(self):
        device = cec.Device.__new__(cec.Device)
        device.fd = 20
        def ioctl(fd, request, buffer, mutate):
            self.assertEqual((fd, request, mutate), (20, cec.CEC_RECEIVE, True))
            self.assertIsInstance(buffer, bytearray)
            self.assertEqual(len(buffer), 56)
            buffer[:] = bytes(packet())
            return 0
        with patch.object(cec, "fcntl", SimpleNamespace(ioctl=ioctl)):
            result = device.ioctl(cec.CEC_RECEIVE, cec.CecMsg())
        self.assertEqual(list(result.msg[:result.len]), [4, 0x44, 1])

    def test_ioctl_disappearance_and_permission_errors_are_sanitized(self):
        device = cec.Device.__new__(cec.Device)
        device.fd = 20
        for number, code in ((errno.EIO, "disconnected"), (errno.ENODEV, "disconnected"),
                             (errno.ENOTTY, "unsupported"), (errno.EPERM, "permission")):
            def ioctl(_fd, _request, _buffer, _mutate):
                raise OSError(number, "sensitive bus dump")
            with patch.object(cec, "fcntl", SimpleNamespace(ioctl=ioctl)):
                with self.assertRaises(cec.CecError) as caught:
                    device.ioctl(cec.CEC_RECEIVE, cec.CecMsg())
            self.assertEqual(str(caught.exception), code)
            self.assertEqual(caught.exception.errno, number)

    def test_main_probe_closes_without_runtime_setup_or_writes(self):
        device = FakeDevice()
        stdout = io.StringIO()
        with patch.object(cec, "Device", return_value=device) as factory, \
                patch.object(cec.signal, "signal"), \
                patch.object(sys, "stdout", stdout):
            self.assertEqual(cec.main(["--device", "/dev/cec1", "--probe"]), 0)
        factory.assert_called_once_with("/dev/cec1", True)
        self.assertEqual(json.loads(stdout.getvalue())["type"], "probe")
        self.assertTrue(device.closed)
        self.assertEqual([request for request, _ in device.calls],
                         [cec.CEC_ADAP_G_CAPS, cec.CEC_ADAP_G_PHYS_ADDR, cec.CEC_ADAP_G_LOG_ADDRS])

    def test_main_surfaces_cleanup_failure_as_fixed_json_and_failure_status(self):
        for earlier_error in (None, cec.CecError("disconnected"), cec.Stopped()):
            device = FakeDevice()
            device.clear_error = OSError(errno.EIO, "sensitive driver details")
            clock = Clock()
            poller = FakePoll(clock)
            stdout, stderr = io.StringIO(), io.StringIO()
            def run(runtime, _stdin_fd):
                runtime.poll_factory = lambda: poller
                runtime.start()
                if earlier_error:
                    raise earlier_error
            with patch.object(cec, "Device", return_value=device), \
                    patch.object(cec.Runtime, "run", run), \
                    patch.object(cec.signal, "signal"), \
                    patch.object(cec.select, "poll", create=True), \
                    patch.object(sys, "stdin", SimpleNamespace(fileno=lambda: 0)), \
                    patch.object(sys, "stdout", stdout), patch.object(sys, "stderr", stderr):
                result = cec.main(["--device", "/dev/cec0"])
            self.assertEqual(result, 1)
            messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
            self.assertEqual(messages[-1], {"type": "error", "code": "cleanup-failed"})
            expected_codes = ["disconnected", "cleanup-failed"] if isinstance(
                earlier_error, cec.CecError) else ["cleanup-failed"]
            self.assertEqual([message["code"] for message in messages if message["type"] == "error"],
                             expected_codes)
            self.assertTrue(device.closed)
            self.assertEqual(stderr.getvalue(), "")

    def test_main_reports_proven_removal_without_hiding_original_terminal_errors(self):
        for original in (None, "disconnected", "protocol"):
            with self.subTest(original=original):
                device = FakeDevice()
                poller = FakePoll(Clock())
                stdout, stderr = io.StringIO(), io.StringIO()
                def run(runtime, _stdin_fd):
                    runtime.poll_factory = lambda: poller
                    runtime.start()
                    device.remove_adapter()
                    if original is not None:
                        raise cec.CecError(original)
                with patch.object(cec, "Device", return_value=device), \
                        patch.object(cec.Runtime, "run", run), \
                        patch.object(cec.signal, "signal"), \
                        patch.object(cec.select, "poll", create=True), \
                        patch.object(sys, "stdin", SimpleNamespace(fileno=lambda: 0)), \
                        patch.object(sys, "stdout", stdout), patch.object(sys, "stderr", stderr):
                    self.assertEqual(cec.main(["--device", "/dev/cec0"]), 1)
                messages = [json.loads(line) for line in stdout.getvalue().splitlines()]
                expected_codes = [original, "adapter-removed"] if original else ["adapter-removed"]
                self.assertEqual([message["code"] for message in messages if message["type"] == "error"],
                                 expected_codes)
                self.assertTrue(device.closed)
                self.assertEqual(stderr.getvalue(), "")

    def test_cli_requires_device_and_emits_only_bounded_error(self):
        for args, code in (([], "protocol"), (["--device", "/dev/../cec0"], "invalid-device"),
                           (["--device", "/dev/cec0", "--standby"], "protocol")):
            stdout, stderr = io.StringIO(), io.StringIO()
            with patch.object(sys, "stdout", stdout), patch.object(sys, "stderr", stderr):
                result = cec.main(args)
            self.assertEqual(result, 1)
            self.assertEqual(json.loads(stdout.getvalue()), {"type": "error", "code": code})
            self.assertEqual(stderr.getvalue(), "")


class AbiTests(unittest.TestCase):
    def test_expected_native_structure_sizes_and_ioctl_encodings(self):
        self.assertEqual([ctypes.sizeof(value) for value in
                          (cec.CecMsg, cec.CecCaps, cec.CecLogAddrs, cec.CecEvent)],
                         [56, 76, 92, 80])
        self.assertEqual(cec.CEC_ADAP_G_CAPS, 0xC04C6100)
        self.assertEqual(cec.CEC_ADAP_G_PHYS_ADDR, 0x80026101)
        self.assertEqual(cec.CEC_ADAP_G_LOG_ADDRS, 0x805C6103)
        self.assertEqual(cec.CEC_ADAP_S_LOG_ADDRS, 0xC05C6104)
        self.assertEqual(cec.CEC_TRANSMIT, 0xC0386105)
        self.assertEqual(cec.CEC_RECEIVE, 0xC0386106)
        self.assertEqual(cec.CEC_DQEVENT, 0xC0506107)
        self.assertEqual(cec.CEC_G_MODE, 0x80046108)
        self.assertEqual(cec.CEC_S_MODE, 0x40046109)
        self.assertEqual(cec.EXCLUSIVE_MODE, 0x22)
        self.assertEqual(cec.CEC_LOG_ADDRS_FL_ALLOW_RC_PASSTHRU, 2)

    @unittest.skipUnless(sys.platform == "linux", "Linux UAPI compiler fixture runs in Linux CI")
    def test_system_linux_header_matches_all_native_fields_flags_and_ioctls(self):
        compiler = shutil.which("cc")
        self.assertIsNotNone(compiler, "Linux ABI validation requires the system C compiler")
        executable = ROOT / "tests" / (".native-cec-abi-" + str(os.getpid()))
        try:
            build = subprocess.run(
                [compiler, "-std=c11", "-Wall", "-Wextra", "-Werror",
                 str(ROOT / "tests" / "native_cec_abi.c"), "-o", str(executable)],
                capture_output=True, text=True, check=False,
                env=dict(os.environ, TMPDIR=str(ROOT / "tests")))
            self.assertEqual(build.returncode, 0, build.stderr)
            output = subprocess.check_output([str(executable)], text=True)
            values = {}
            for line in output.splitlines():
                name, value = line.split("=")
                values[name] = int(value)
            for name, value in values.items():
                if "." not in name:
                    expected = getattr(cec, name)
                else:
                    struct_name, field = name.split(".")
                    structure = getattr(cec, struct_name)
                    if field == "size":
                        expected = ctypes.sizeof(structure)
                    elif field == "alignment":
                        expected = ctypes.alignment(structure)
                    else:
                        expected = getattr(structure, field).offset
                with self.subTest(name=name):
                    self.assertEqual(value, expected)
            self.assertGreater(len(values), 80)
        finally:
            executable.unlink(missing_ok=True)

    def test_build_and_installer_package_the_runtime_not_just_typescript(self):
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertIn("node scripts/copy-runtime.mjs", package["scripts"]["build"])
        installer = (ROOT / "scripts" / "install.sh").read_text(encoding="utf-8")
        self.assertIn("dist/server/server/native-cec.py", installer)
        packages = next(line for line in installer.splitlines() if line.startswith("apt-get install "))
        self.assertIn("python3", packages.split())
        self.assertIn("--omit=dev --ignore-scripts", installer)
        self.assertLess(installer.index("check_system_runtime /usr/bin/node /usr/bin/npm"),
                        installer.index("apt-get install"))


if __name__ == "__main__":
    unittest.main()
