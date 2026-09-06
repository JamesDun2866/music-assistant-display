#!/usr/bin/env python3
"""Linux CEC transport for manual actions and exact-path TV acknowledgements."""

import argparse
import ctypes
import errno
import json
import os
import platform
import re
import select
import signal
import stat
import sys
import time

try:
    import fcntl
except ImportError:
    fcntl = None


# The Linux CEC UAPI definitions below are translated from Linux v6.12
# include/uapi/linux/cec.h, using its BSD-3-Clause license option.
# Copyright 2016 Cisco Systems, Inc. and/or its affiliates. All rights reserved.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are met:
#
# 1. Redistributions of source code must retain the above copyright notice,
#    this list of conditions and the following disclaimer.
#
# 2. Redistributions in binary form must reproduce the above copyright
#    notice, this list of conditions and the following disclaimer in the
#    documentation and/or other materials provided with the distribution.
#
# 3. Neither the name of the copyright holder nor the names of its
#    contributors may be used to endorse or promote products derived from this
#    software without specific prior written permission.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
# AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
# IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
# ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
# LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
# CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
# SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
# INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
# CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
# ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
# POSSIBILITY OF SUCH DAMAGE.
#
# Project-authored transport logic is MIT licensed; see THIRD_PARTY_NOTICES.md.
# The Linux test
# compiles against the system header and compares every field and ioctl.
class CecMsg(ctypes.Structure):
    _fields_ = [
        ("tx_ts", ctypes.c_uint64), ("rx_ts", ctypes.c_uint64),
        ("len", ctypes.c_uint32), ("timeout", ctypes.c_uint32),
        ("sequence", ctypes.c_uint32), ("flags", ctypes.c_uint32),
        ("msg", ctypes.c_uint8 * 16), ("reply", ctypes.c_uint8),
        ("rx_status", ctypes.c_uint8), ("tx_status", ctypes.c_uint8),
        ("tx_arb_lost_cnt", ctypes.c_uint8), ("tx_nack_cnt", ctypes.c_uint8),
        ("tx_low_drive_cnt", ctypes.c_uint8), ("tx_error_cnt", ctypes.c_uint8),
    ]


class CecCaps(ctypes.Structure):
    _fields_ = [
        ("driver", ctypes.c_char * 32), ("name", ctypes.c_char * 32),
        ("available_log_addrs", ctypes.c_uint32),
        ("capabilities", ctypes.c_uint32), ("version", ctypes.c_uint32),
    ]


class CecLogAddrs(ctypes.Structure):
    _fields_ = [
        ("log_addr", ctypes.c_uint8 * 4), ("log_addr_mask", ctypes.c_uint16),
        ("cec_version", ctypes.c_uint8), ("num_log_addrs", ctypes.c_uint8),
        ("vendor_id", ctypes.c_uint32), ("flags", ctypes.c_uint32),
        ("osd_name", ctypes.c_char * 15),
        ("primary_device_type", ctypes.c_uint8 * 4),
        ("log_addr_type", ctypes.c_uint8 * 4),
        ("all_device_types", ctypes.c_uint8 * 4),
        ("features", (ctypes.c_uint8 * 12) * 4),
    ]


class CecStateChange(ctypes.Structure):
    _fields_ = [
        ("phys_addr", ctypes.c_uint16), ("log_addr_mask", ctypes.c_uint16),
        ("have_conn_info", ctypes.c_uint16),
    ]


class CecLostMsgs(ctypes.Structure):
    _fields_ = [("lost_msgs", ctypes.c_uint32)]


class CecEventData(ctypes.Union):
    _fields_ = [
        ("state_change", CecStateChange), ("lost_msgs", CecLostMsgs),
        ("raw", ctypes.c_uint32 * 16),
    ]


class CecEvent(ctypes.Structure):
    _anonymous_ = ("data",)
    _fields_ = [
        ("ts", ctypes.c_uint64), ("event", ctypes.c_uint32),
        ("flags", ctypes.c_uint32), ("data", CecEventData),
    ]


def _ioc(direction, number, data_type):
    # asm-generic ioctl encoding, used by supported ARM64 and x86-64 Linux targets.
    return (direction << 30) | (ctypes.sizeof(data_type) << 16) | (ord("a") << 8) | number


CEC_ADAP_G_CAPS = _ioc(3, 0, CecCaps)
CEC_ADAP_G_PHYS_ADDR = _ioc(2, 1, ctypes.c_uint16)
CEC_ADAP_G_LOG_ADDRS = _ioc(2, 3, CecLogAddrs)
CEC_ADAP_S_LOG_ADDRS = _ioc(3, 4, CecLogAddrs)
CEC_TRANSMIT = _ioc(3, 5, CecMsg)
CEC_RECEIVE = _ioc(3, 6, CecMsg)
CEC_DQEVENT = _ioc(3, 7, CecEvent)
CEC_G_MODE = _ioc(2, 8, ctypes.c_uint32)
CEC_S_MODE = _ioc(1, 9, ctypes.c_uint32)
CEC_CAP_LOG_ADDRS = 1 << 1
CEC_CAP_TRANSMIT = 1 << 2
CEC_CAP_CONNECTOR_INFO = 1 << 8
CEC_MODE_EXCL_INITIATOR = 0x02
CEC_MODE_EXCL_FOLLOWER = 0x20
CEC_LOG_ADDRS_FL_ALLOW_RC_PASSTHRU = 1 << 1
CEC_LOG_ADDR_TYPE_PLAYBACK = 3
CEC_OP_PRIM_DEVTYPE_PLAYBACK = 4
CEC_OP_ALL_DEVTYPE_PLAYBACK = 0x10
CEC_OP_CEC_VERSION_1_4 = 5
CEC_VENDOR_ID_NONE = 0xFFFFFFFF
CEC_PHYS_ADDR_INVALID = 0xFFFF
CEC_EVENT_STATE_CHANGE = 1
CEC_EVENT_LOST_MSGS = 2
CEC_EVENT_FL_INITIAL_STATE = 1
CEC_EVENT_FL_DROPPED_EVENTS = 2
CEC_TX_STATUS_OK = 0x01
CEC_TX_STATUS_MAX_RETRIES = 0x20
CEC_TX_STATUS_ABORTED = 0x40
CEC_TX_STATUS_TIMEOUT = 0x80
CEC_RX_STATUS_OK = 0x01
CEC_MSG_IMAGE_VIEW_ON = 0x04
CEC_MSG_ACTIVE_SOURCE = 0x82
CEC_MSG_SET_STREAM_PATH = 0x86
ROUTING_LENGTHS = {0x36: 2, 0x80: 6, 0x81: 4, 0x82: 4, 0x86: 4, 0x9D: 4}

# poll is unavailable on Windows; constants allow hardware-free fixtures there.
POLLIN = getattr(select, "POLLIN", 0x001)
POLLPRI = getattr(select, "POLLPRI", 0x002)
POLLERR = getattr(select, "POLLERR", 0x008)
POLLHUP = getattr(select, "POLLHUP", 0x010)
POLLNVAL = getattr(select, "POLLNVAL", 0x020)
DEVICE_EVENTS = POLLIN | POLLPRI | POLLERR | POLLHUP | POLLNVAL
EXCLUSIVE_MODE = CEC_MODE_EXCL_INITIATOR | CEC_MODE_EXCL_FOLLOWER
PLAYBACK_ADDRESSES = (4, 8, 11)
MAX_LINE = 1024
MAX_PENDING = 16
TX_TIMEOUT = 5.0
CLAIM_TIMEOUT = 10.0
ROUTE_COOLDOWN = 2.0
MAX_EVENT_ID = 9007199254740991
RECEIVE_BATCH = 64


class CecError(Exception):
    def __init__(self, code, *, error_number=None):
        self.code = code
        self.errno = error_number
        super().__init__(code)


class Stopped(Exception):
    pass


def error_code(exc, opening=False):
    if exc.errno in (errno.EACCES, errno.EPERM):
        return "permission"
    if exc.errno == errno.EBUSY:
        return "busy"
    if exc.errno in (errno.ENOTTY, errno.EOPNOTSUPP):
        return "unsupported"
    if exc.errno == getattr(errno, "ENONET", 64):
        return "no-physical-address"
    if exc.errno in (errno.ELOOP, errno.ENOTDIR):
        return "invalid-device"
    if opening and exc.errno in (errno.ENOENT, errno.ENODEV, errno.ENXIO):
        return "missing-device"
    if exc.errno in (errno.ENOENT, errno.ENODEV, errno.ENXIO, errno.EIO, errno.EBADF):
        return "disconnected"
    return "protocol"


def validate_device_path(path):
    if not isinstance(path, str) or re.fullmatch(r"/dev/cec(?:0|[1-9][0-9]*)", path) is None:
        raise CecError("invalid-device")


def open_device(path, probe=False, system=os):
    validate_device_path(path)
    if not hasattr(system, "O_NOFOLLOW"):
        raise CecError("unsupported")
    fd = None
    opened = False
    try:
        before = system.lstat(path)
        if not stat.S_ISCHR(before.st_mode):
            raise CecError("invalid-device")
        flags = (system.O_RDONLY if probe else system.O_RDWR)
        flags |= system.O_NONBLOCK | system.O_CLOEXEC | system.O_NOFOLLOW
        fd = system.open(path, flags)
        after = system.fstat(fd)
        if not stat.S_ISCHR(after.st_mode) or (
            before.st_dev, before.st_ino, before.st_rdev
        ) != (after.st_dev, after.st_ino, after.st_rdev):
            raise CecError("invalid-device")
        opened = True
        return fd
    except OSError as exc:
        raise CecError(error_code(exc, opening=True)) from None
    finally:
        if fd is not None and not opened:
            system.close(fd)


class Device:
    def __init__(self, path, probe=False):
        if (sys.platform != "linux" or fcntl is None or ctypes.sizeof(ctypes.c_void_p) != 8 or
                platform.machine().lower() not in ("aarch64", "arm64", "x86_64")):
            raise CecError("unsupported")
        self.fd = open_device(path, probe)

    def ioctl(self, request, value):
        buffer = bytearray(bytes(value))
        try:
            fcntl.ioctl(self.fd, request, buffer, True)
        except OSError as exc:
            if exc.errno in (errno.EAGAIN, errno.EINTR):
                raise
            raise CecError(error_code(exc), error_number=exc.errno) from None
        return type(value).from_buffer_copy(buffer)

    def close(self):
        os.close(self.fd)


def physical_address_valid(address):
    if not 0 < address < CEC_PHYS_ADDR_INVALID:
        return False
    zero = False
    for shift in (12, 8, 4, 0):
        part = (address >> shift) & 0xF
        if zero and part:
            return False
        zero = zero or part == 0
    return True


def probe_device(device, path):
    caps = device.ioctl(CEC_ADAP_G_CAPS, CecCaps())
    physical = device.ioctl(CEC_ADAP_G_PHYS_ADDR, ctypes.c_uint16()).value
    addresses = device.ioctl(CEC_ADAP_G_LOG_ADDRS, CecLogAddrs())
    return {
        "type": "probe", "device": path, "capabilities": caps.capabilities,
        "availableLogicalAddresses": caps.available_log_addrs,
        "physicalAddress": physical,
        "logicalAddresses": list(addresses.log_addr[:min(addresses.num_log_addrs, 4)]),
        "logicalAddressMask": addresses.log_addr_mask, "flags": addresses.flags,
        "configured": bool(addresses.num_log_addrs or addresses.log_addr_mask),
    }


class Runtime:
    def __init__(self, device, emit, poll_factory=None, clock=time.monotonic, stopped=lambda: False):
        self.device = device
        self.emit = emit
        self.poll_factory = poll_factory or select.poll
        self.clock = clock
        self.stopped = stopped
        self.physical = None
        self.logical = None
        self.capabilities = 0
        self.owns_registration = False
        self.closed = False
        self.pending = {}
        self.input_buffer = bytearray()
        self.ready = False
        self.routing_id = 0
        self.routing = None
        self.route_candidate = None
        self.route_blocked = False
        self.last_route_match = None

    def _check_stop(self):
        if self.stopped():
            self._cancel_route()
            raise Stopped()

    def _physical(self):
        physical = self.device.ioctl(CEC_ADAP_G_PHYS_ADDR, ctypes.c_uint16()).value
        if not physical_address_valid(physical):
            raise CecError("no-physical-address")
        if self.physical is not None and physical != self.physical:
            raise CecError("disconnected")
        return physical

    def _addresses(self):
        return self.device.ioctl(CEC_ADAP_G_LOG_ADDRS, CecLogAddrs())

    @staticmethod
    def _unowned(addresses):
        if addresses.num_log_addrs or addresses.log_addr_mask:
            # close(2), including SIGKILL, leaves this adapter-wide state intact.
            # OSD names cannot identify an owner. Recovery is an operator action.
            raise CecError("registration-present")

    def _claimed(self, addresses):
        if addresses.flags & CEC_LOG_ADDRS_FL_ALLOW_RC_PASSTHRU:
            raise CecError("unsupported")
        if not addresses.log_addr_mask and addresses.num_log_addrs == 1 and self.logical is None:
            return False
        logical = addresses.log_addr[0]
        if (addresses.num_log_addrs != 1 or logical not in PLAYBACK_ADDRESSES or
                addresses.log_addr_mask != 1 << logical or
                addresses.log_addr_type[0] != CEC_LOG_ADDR_TYPE_PLAYBACK or
                (self.logical is not None and self.logical != logical)):
            raise CecError("no-logical-address")
        self.logical = logical
        return True

    def validate_registration(self):
        self._physical()
        if not self._claimed(self._addresses()):
            raise CecError("no-logical-address")
        if self.device.ioctl(CEC_G_MODE, ctypes.c_uint32()).value != EXCLUSIVE_MODE:
            raise CecError("unsupported")

    def start(self):
        caps = self.device.ioctl(CEC_ADAP_G_CAPS, CecCaps())
        required = CEC_CAP_LOG_ADDRS | CEC_CAP_TRANSMIT
        if (caps.capabilities & required) != required or not 1 <= caps.available_log_addrs <= 4:
            raise CecError("unsupported")
        self.capabilities = caps.capabilities
        self._unowned(self._addresses())
        self.physical = self._physical()
        self.device.ioctl(CEC_S_MODE, ctypes.c_uint32(EXCLUSIVE_MODE))
        mode = self.device.ioctl(CEC_G_MODE, ctypes.c_uint32()).value
        if mode != EXCLUSIVE_MODE:
            raise CecError("unsupported")
        # Recheck after taking exclusive access. Never clear another owner's
        # adapter-wide registration, including an in-progress claim.
        self._unowned(self._addresses())
        self.drain_events(configuring=True)
        self._physical()
        self._check_stop()
        addresses = CecLogAddrs()
        addresses.cec_version = CEC_OP_CEC_VERSION_1_4
        addresses.num_log_addrs = 1
        addresses.vendor_id = CEC_VENDOR_ID_NONE
        addresses.flags = 0  # In particular, disable rc-core key passthrough.
        addresses.osd_name = b"Sendspin"
        addresses.primary_device_type[0] = CEC_OP_PRIM_DEVTYPE_PLAYBACK
        addresses.log_addr_type[0] = CEC_LOG_ADDR_TYPE_PLAYBACK
        addresses.all_device_types[0] = CEC_OP_ALL_DEVTYPE_PLAYBACK
        self.device.ioctl(CEC_ADAP_S_LOG_ADDRS, addresses)
        self.owns_registration = True
        poller = self.poll_factory()
        poller.register(self.device.fd, POLLPRI | POLLERR | POLLHUP | POLLNVAL)
        deadline = self.clock() + CLAIM_TIMEOUT
        while True:
            self._check_stop()
            self.drain_events(configuring=True)
            self._physical()
            if self._claimed(self._addresses()):
                break
            if self.clock() >= deadline:
                raise CecError("no-logical-address")
            self._poll(poller, 100)
        self.validate_registration()
        self.ready = True
        self.emit({"type": "ready", "logicalAddress": self.logical, "physicalAddress": self.physical})

    def _poll(self, poller, timeout):
        try:
            events = poller.poll(timeout)
        except OSError as exc:
            if exc.errno == errno.EINTR:
                # An interrupted final readiness probe is not an empty queue.
                return [(self.device.fd, POLLIN)] if timeout == 0 else []
            raise CecError(error_code(exc)) from None
        for fd, mask in events:
            if fd == self.device.fd and mask & (POLLERR | POLLHUP | POLLNVAL):
                self._cancel_route()
                raise CecError("disconnected")
        return events

    def drain_events(self, configuring=False):
        for _ in range(64):
            try:
                event = self.device.ioctl(CEC_DQEVENT, CecEvent())
            except CecError:
                self._cancel_route()
                raise
            except OSError as exc:
                if exc.errno == errno.EAGAIN:
                    return True
                if exc.errno == errno.EINTR:
                    self._cancel_route("suppressed")
                    return False
                self._cancel_route()
                raise
            self._check_stop()
            if not configuring:
                self._cancel_route()
                self.route_blocked = True
            if event.flags & CEC_EVENT_FL_DROPPED_EVENTS:
                if not configuring:
                    self.emit({"type": "reset", "reason": "messages-lost"})
                raise CecError("disconnected")
            if event.event == CEC_EVENT_LOST_MSGS:
                if configuring:
                    raise CecError("disconnected")
                self.fail_pending()
                self.emit({"type": "reset", "reason": "messages-lost"})
            elif event.event == CEC_EVENT_STATE_CHANGE:
                state = event.state_change
                if (self.capabilities & CEC_CAP_CONNECTOR_INFO) and not state.have_conn_info:
                    raise CecError("disconnected")
                if not physical_address_valid(state.phys_addr):
                    raise CecError("no-physical-address")
                if state.phys_addr != self.physical:
                    raise CecError("disconnected")
                if not configuring:
                    if state.log_addr_mask != 1 << self.logical:
                        raise CecError("no-logical-address")
                    self.emit({"type": "reset", "reason": "routing-change"})
                    self.validate_registration()
        self._cancel_route("suppressed")
        self.route_blocked = True
        return False

    def _routing_update(self, event_id, acknowledgement):
        if (self.routing is not None and self.routing["id"] == event_id and
                self.routing["acknowledgement"] == "pending"):
            self.routing = {**self.routing, "acknowledgement": acknowledgement}
            self.emit(dict(self.routing))

    def _cancel_route(self, acknowledgement="cancelled"):
        self.route_candidate = None
        if self.routing is not None:
            self._routing_update(self.routing["id"], acknowledgement)

    def _observe_routing(self, message):
        if message.len < 2 or message.msg[1] not in ROUTING_LENGTHS:
            return
        opcode, source, target = message.msg[1], message.msg[0] >> 4, message.msg[0] & 15
        physical = None
        if opcode in (0x81, 0x82, 0x86, 0x9D) and message.len == 4:
            physical = (message.msg[2] << 8) | message.msg[3]
        elif opcode == 0x80 and message.len == 6:
            physical = (message.msg[4] << 8) | message.msg[5]
        decision, acknowledgement = "observed", "none"
        coalescing = self.route_candidate is not None
        if opcode == CEC_MSG_SET_STREAM_PATH:
            if source != 0:
                decision = "wrong-source"
            elif target != 15:
                decision = "wrong-target"
            elif message.len != 4:
                decision = "wrong-length"
            elif (not self.ready or self.closed or not self.owns_registration or
                  self.logical not in PLAYBACK_ADDRESSES or self.physical is None or
                  not physical_address_valid(self.physical)):
                decision = "invalid-registration"
            elif physical != self.physical:
                decision = "wrong-path"
            else:
                decision = "matched"
                now = self.clock()
                duplicate = (self.last_route_match is not None and
                             now - self.last_route_match < ROUTE_COOLDOWN)
                self.last_route_match = now
                acknowledgement = ("suppressed" if self.route_blocked or self.pending or
                                   self.input_buffer or (duplicate and not coalescing)
                                   else "pending")
        elif (opcode in (0x80, 0x81) and physical != self.physical or
              opcode == 0x82 and source != self.logical or opcode in (0x36, 0x9D)):
            decision = "route-away"
        if decision in ("wrong-path", "route-away"):
            self.route_blocked = True
        # Keep only the latest diagnostic and one unsent authorization.
        self._cancel_route()
        if self.routing_id >= MAX_EVENT_ID:
            raise CecError("protocol")
        self.routing_id += 1
        self.routing = {
            "type": "routing", "id": self.routing_id, "opcode": opcode,
            "source": source, "target": target, "physicalAddress": physical,
            "decision": decision, "acknowledgement": acknowledgement,
        }
        self.emit(dict(self.routing))
        if acknowledgement == "pending":
            self.route_candidate = (self.routing_id, self.physical, self.logical)
        if decision == "route-away" and message.len == ROUTING_LENGTHS[opcode]:
            routing_source = source in (0, 5) if opcode == 0x36 else source != 15
            normalized = (opcode != 0x9D and routing_source and source != self.logical and
                          target in (self.logical, 15))
            if routing_source and not normalized:
                # Inactive Source (usually directed to the TV) and directed-away
                # routes are not handled by the parent packet normalizer.
                self.emit({"type": "reset", "reason": "routing-change"})

    def dispatch_route(self, stdin_pending=lambda: False):
        if self.route_candidate is None:
            return
        try:
            self._check_stop()
            if not self.drain_events():
                return
            # A poll readiness notification is not proof that the queue was drained.
            # Never carry an authorization across a bounded/incomplete receive drain.
            if not self.receive():
                return
            if not self.drain_events():
                return
            candidate = self.route_candidate
            if candidate is None:
                return
            event_id, physical, logical = candidate
            if (self.pending or self.input_buffer or self.route_blocked or not self.ready or
                    self.closed or not self.owns_registration):
                self._cancel_route("suppressed")
                return
            if stdin_pending():
                self._cancel_route("suppressed")
                return
            self.validate_registration()
            if (physical, logical) != (self.physical, self.logical):
                self._cancel_route()
                return
            # Registration ioctls can allow more bus/stdin events to arrive.
            # Probe again immediately before handing the frame to the kernel.
            if stdin_pending():
                self._cancel_route("suppressed")
                return
            self._check_stop()
            self.route_candidate = None
            self._transmit(("routing", event_id), "active-source")
        except (CecError, OSError, Stopped):
            self._cancel_route()
            raise

    def _result(self, command_id, ok):
        if isinstance(command_id, tuple):
            self._routing_update(command_id[1], "sent" if ok else "failed")
            return
        self.emit({"type": "result", "id": command_id, "ok": bool(ok)})

    def fail_pending(self):
        self._cancel_route()
        pending, self.pending = self.pending, {}
        for command_id, _ in pending.values():
            self._result(command_id, False)

    @staticmethod
    def _tx_ok(status):
        return bool(status & CEC_TX_STATUS_OK) and not status & (
            CEC_TX_STATUS_MAX_RETRIES | CEC_TX_STATUS_ABORTED | CEC_TX_STATUS_TIMEOUT
        )

    def command(self, command):
        self._check_stop()
        if (not isinstance(command, dict) or set(command) != {"id", "command"} or
                type(command["id"]) is not int or not 0 < command["id"] <= 9007199254740991 or
                command["command"] not in ("wake", "active-source")):
            raise CecError("protocol")
        self._cancel_route()
        self.route_blocked = True
        command_id = command["id"]
        if any(command_id == item[0] for item in self.pending.values()):
            raise CecError("protocol")
        if len(self.pending) >= MAX_PENDING:
            self._result(command_id, False)
            return
        try:
            if self.logical is None or not self.owns_registration or self.closed:
                raise CecError("no-logical-address")
            self.drain_events()
            self.validate_registration()
        except CecError as exc:
            self._result(command_id, False)
            if exc.code == "busy":
                return
            raise
        except OSError as exc:
            self._result(command_id, False)
            if exc.errno in (errno.EAGAIN, errno.EINTR):
                return
            raise CecError(error_code(exc)) from None
        self._transmit(command_id, command["command"])

    def _transmit(self, command_id, command):
        if command == "wake":
            payload = [self.logical << 4, CEC_MSG_IMAGE_VIEW_ON]
        else:
            payload = [(self.logical << 4) | 15, CEC_MSG_ACTIVE_SOURCE,
                       self.physical >> 8, self.physical & 255]
        message = CecMsg()
        message.len = len(payload)
        message.msg[:len(payload)] = payload
        # timeout and reply stay zero: only the transmit completion is wanted.
        try:
            result = self.device.ioctl(CEC_TRANSMIT, message)
        except CecError as exc:
            self._result(command_id, False)
            if exc.code == "busy":
                return
            raise
        except OSError as exc:
            self._result(command_id, False)
            if exc.errno in (errno.EAGAIN, errno.EINTR):
                return
            raise CecError(error_code(exc)) from None
        if not result.sequence or result.sequence in self.pending:
            self._result(command_id, False)
            raise CecError("protocol")
        if result.tx_status:
            self._result(command_id, self._tx_ok(result.tx_status) and not result.rx_status)
        else:
            self.pending[result.sequence] = (command_id, self.clock() + TX_TIMEOUT)

    def receive(self):
        if self.pending:
            self.route_blocked = True
        for _ in range(RECEIVE_BATCH):
            self._check_stop()
            try:
                message = self.device.ioctl(CEC_RECEIVE, CecMsg())
            except CecError:
                self._cancel_route()
                raise
            except OSError as exc:
                if exc.errno == errno.EAGAIN:
                    self.route_blocked = False
                    return True
                if exc.errno == errno.EINTR:
                    self._cancel_route("suppressed")
                    self.route_blocked = True
                    return False
                self._cancel_route()
                raise
            if not 1 <= message.len <= 16:
                self._cancel_route()
                raise CecError("protocol")
            if message.sequence:
                if message.tx_status and not message.rx_status:
                    pending = self.pending.pop(message.sequence, None)
                    if pending is not None:
                        self._result(pending[0], self._tx_ok(message.tx_status)
                                     and self.clock() < pending[1])
                # Completions and replies can never become remote-control input.
                continue
            if message.tx_status or message.rx_status != CEC_RX_STATUS_OK:
                continue
            self._observe_routing(message)
            self.emit({
                "type": "packet", "message": list(message.msg[:message.len]),
                "sequence": message.sequence, "txStatus": message.tx_status,
                "rxStatus": message.rx_status,
            })
        self._cancel_route("suppressed")
        self.route_blocked = True
        return False

    def expire_commands(self):
        now = self.clock()
        for sequence, (command_id, deadline) in list(self.pending.items()):
            if now >= deadline:
                del self.pending[sequence]
                self._result(command_id, False)

    def feed(self, data):
        if data:
            self._cancel_route()
        self.input_buffer.extend(data)
        while b"\n" in self.input_buffer:
            end = self.input_buffer.index(b"\n")
            if end > MAX_LINE:
                raise CecError("protocol")
            line = bytes(self.input_buffer[:end])
            del self.input_buffer[:end + 1]
            try:
                command = json.loads(line.decode("utf-8"), object_pairs_hook=unique_object,
                                     parse_constant=reject_constant)
            except (ValueError, UnicodeError, RecursionError):
                raise CecError("protocol") from None
            self.command(command)
        if len(self.input_buffer) > MAX_LINE:
            raise CecError("protocol")

    def run(self, stdin_fd, read=os.read):
        self.start()
        poller = self.poll_factory()
        poller.register(self.device.fd, DEVICE_EVENTS)
        poller.register(stdin_fd, POLLIN | POLLHUP | POLLERR | POLLNVAL)
        while not self.stopped():
            self.expire_commands()
            events = self._poll(poller, 100)
            if self.stopped():
                return
            # Device state must be processed before commands from the same poll.
            for fd, mask in events:
                if fd == self.device.fd and mask & POLLPRI:
                    self.drain_events()
            for fd, mask in events:
                if fd == self.device.fd and mask & POLLIN:
                    self.receive()
            for fd, mask in events:
                if fd != stdin_fd:
                    continue
                if mask & (POLLERR | POLLNVAL):
                    return
                if mask & (POLLIN | POLLHUP):
                    try:
                        data = read(stdin_fd, 4096)
                    except OSError as exc:
                        if exc.errno in (errno.EAGAIN, errno.EINTR):
                            continue
                        raise CecError("protocol") from None
                    if not data:
                        if self.input_buffer:
                            raise CecError("protocol")
                        return
                    self.feed(data)
            if any(fd == stdin_fd for fd, _ in events):
                self._cancel_route("suppressed")
            else:
                # Any newly readable input wins over the unsent acknowledgement.
                self.dispatch_route(lambda: any(
                    fd == stdin_fd or (fd == self.device.fd and mask & (POLLIN | POLLPRI))
                    for fd, mask in self._poll(poller, 0)))

    def close(self):
        if self.closed:
            return
        self.closed = True
        self.ready = False
        cleanup_error = None
        try:
            self.fail_pending()
        finally:
            try:
                if self.owns_registration:
                    # Registration is adapter-wide, not released by close(2).
                    # Clear only ours, while our exclusive filehandle still owns it.
                    self.device.ioctl(CEC_ADAP_S_LOG_ADDRS, CecLogAddrs())
                    remaining = self._addresses()
                    if remaining.num_log_addrs or remaining.log_addr_mask:
                        raise CecError("cleanup-failed")
                    self.owns_registration = False
            except (CecError, OSError):
                cleanup_error = "cleanup-failed"
                try:
                    self._addresses()
                except (CecError, OSError) as exc:
                    # G_LOG_ADDRS has no driver callback: ENODEV proves that
                    # cec_devnode_unregister ran, which clears adapter state.
                    # A failed clear alone (or EIO/EBADF) does not prove removal.
                    if exc.errno == errno.ENODEV:
                        cleanup_error = "adapter-removed"
            finally:
                try:
                    self.device.close()
                except (CecError, OSError):
                    cleanup_error = "cleanup-failed"
            if cleanup_error is not None:
                raise CecError(cleanup_error)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError()
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError()


def emit_json(value):
    print(json.dumps(value, separators=(",", ":")), flush=True)


class Arguments(argparse.ArgumentParser):
    def error(self, _message):
        raise CecError("protocol")


def main(argv=None):
    runtime = None
    device = None
    stopping = False
    result = 0

    def stop(_signum, _frame):
        nonlocal stopping
        stopping = True

    try:
        parser = Arguments(description=__doc__)
        parser.add_argument("--device", required=True)
        parser.add_argument("--probe", action="store_true", help="read-only adapter diagnostics")
        args = parser.parse_args(argv)
        validate_device_path(args.device)
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        device = Device(args.device, args.probe)
        if args.probe:
            emit_json(probe_device(device, args.device))
        else:
            runtime = Runtime(device, emit_json, stopped=lambda: stopping)
            runtime.run(sys.stdin.fileno())
    except Stopped:
        pass
    except CecError as exc:
        emit_json({"type": "error", "code": exc.code})
        result = 1
    except OSError as exc:
        emit_json({"type": "error", "code": error_code(exc)})
        result = 1
    finally:
        try:
            if runtime is not None:
                runtime.close()
            elif device is not None:
                device.close()
        except CecError as exc:
            # Preserve the earlier failure before reporting cleanup's outcome;
            # confirmed removal must not hide a terminal protocol failure.
            emit_json({"type": "error", "code": exc.code})
            result = 1
        except OSError:
            emit_json({"type": "error", "code": "cleanup-failed"})
            result = 1
    return result


if __name__ == "__main__":
    try:
        sys.exit(main())
    except BrokenPipeError:
        # The supervisor has gone away; never print a traceback or bus data.
        os._exit(0)
