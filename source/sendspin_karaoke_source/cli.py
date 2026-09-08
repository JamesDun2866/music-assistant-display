"""Explicit pairing and reconnecting source-only command line."""

import asyncio
import dataclasses
import json
import logging
import secrets
import signal
import sys
import time

from aiosendspin.client import PairingSupport, SendspinClient
from aiosendspin.models.source import ClientHelloSourceSupport
from aiosendspin.models.types import Roles
from aiosendspin.noise.pairing import PairingError

from .audio import check_device, discover
from .bridge import SourceBridge, paired
from .config import CaptureError, PairingRequired, SourceError, parse_args
from .lifecycle import TRANSPORT_ERRORS, cleanup_async, disconnect_client, error_classes, sdk_call
from .state import load_identity, locked_state, open_store
from .control import ControlServer, request
from .recording import Recorder
from .shared import SharedCapture
from .recognition import Recognition
from .meters import Meters
from .source_health import SourceHealth
from .tools import ToolsServer

LOG = logging.getLogger(__name__)
PAIR_TIMEOUT = 120


def make_client(config, identity, store, *, pairing=False, clock=None):
    return SendspinClient(
        identity, config.name, [Roles.SOURCE], pairing_store=store,
        source_support=ClientHelloSourceSupport(),
        clock=clock,
        pairing_support=PairingSupport(
            offer_static_pin=True, secret_locations=("device",),
        ) if pairing else None,
    )


async def pairing_policy(store, enabled=False):
    config = await store.get_pairing_config()
    await store.store_pairing_config(dataclasses.replace(
        config, static_pin_enabled=enabled, dynamic_pin_enabled=False,
        pairing_psk_enabled=False, unpaired_access_enabled=False,
    ))
    if not enabled:
        await store.clear_static_pin()


async def pair(config, identity, store):
    if not sys.stdout.isatty():
        raise SourceError("Pairing requires a terminal; PINs must not be redirected into logs.")
    await pairing_policy(store, True)
    client = None
    try:
        pin = "".join(secrets.choice("0123456789") for _ in range(8))
        await store.set_static_pin(pin)
        client = make_client(config, identity, store, pairing=True)
        client.open_pairing_window()
        print(f"Pairing PIN: {pin}\nEnter this PIN in Music Assistant's Sendspin source setup.")
        print("Waiting up to 120 seconds. No capture device will be opened.")
        async with asyncio.timeout(PAIR_TIMEOUT):
            await sdk_call(client.connect, config.server_url)
            while not paired(client):
                if not client.connected:
                    raise PairingRequired("Pairing connection closed; retry 'pair' and approve it in Music Assistant.")
                await asyncio.sleep(0.2)
        print("Paired successfully. Configure the source, then explicitly enable/start its service.")
    except TimeoutError:
        raise PairingRequired("Pairing timed out. Retry 'pair' when Music Assistant is ready.") from None
    except PairingError as error:
        raise PairingRequired(
            f"Pairing failed ({error_classes(error)}); retry 'pair' and check the PIN in Music Assistant."
        ) from None
    finally:
        steps = []
        if client is not None:
            steps.append(("pairing disconnect", lambda: sdk_call(client.disconnect)))
        steps.append(("disable pairing/PIN", lambda: pairing_policy(store)))
        await cleanup_async(steps, primary=sys.exception())


async def wait_events(*events):
    tasks = [asyncio.create_task(event.wait()) for event in events]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def run(
    config, identity, store, *,
    client_factory=make_client, bridge_factory=SourceBridge, sleep=asyncio.sleep, health=None,
):
    await pairing_policy(store)
    if not any(record.server_id or record.used for record in await store.list_records()):
        raise PairingRequired("No server pairing. Run 'pair' as the service user with this same --state-dir first.")
    delay = 1
    while True:
        disconnected = asyncio.Event()
        client = client_factory(config, identity, store)
        bridge = None
        began = time.monotonic()
        try:
            try:
                bridge = bridge_factory(client, config.device)
                if health is not None:
                    health.connecting(bridge)
                def transport_disconnected():
                    disconnected.set()
                    if health is not None:
                        health.disconnected()
                client.add_disconnect_listener(transport_disconnected)
                async with asyncio.timeout(20):
                    await sdk_call(client.connect, config.server_url)
                if not paired(client):
                    raise PairingRequired(
                        "Server did not admit a paired source. Stop the service and run 'pair' "
                        "again as the service user (check the configured server and state directory)."
                    )
                LOG.info("Paired source connected; idle until Music Assistant requests START.")
                if health is not None:
                    health.connected(bridge)
                await wait_events(disconnected, bridge.failed)
                if bridge.failure is not None:
                    raise bridge.failure
            finally:
                if health is not None:
                    health.disconnected()
                primary = sys.exception()
                try:
                    if bridge is not None:
                        await cleanup_async([("source bridge close", bridge.close)], primary=primary)
                finally:
                    # Cancellation during bridge cleanup must still retire the old
                    # client's socket/session/tasks before leaving this attempt.
                    await cleanup_async(
                        [("source client disconnect", lambda: disconnect_client(client))],
                        primary=sys.exception() or primary,
                    )
        except PairingRequired:
            raise
        except CaptureError as error:
            if health is not None:
                health.error("unavailable")
            LOG.warning("%s", error)
        except TRANSPORT_ERRORS as error:
            if health is not None:
                health.error("offline")
            LOG.warning(
                "Source transport failed (%s). Check server reachability; "
                "if server trust was reset, stop this service and explicitly re-pair.",
                error_classes(error),
            )
        if time.monotonic() - began >= 30:
            delay = 1
        LOG.info("Disconnected; retrying in %s seconds. Old capture audio discarded.", delay)
        await sleep(delay)
        delay = min(delay * 2, 30)


async def dispatch(config):
    task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    registered = []
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, task.cancel)
            registered.append(sig)
        except NotImplementedError:
            pass
    try:
        if config.command == "check-device":
            await check_device(config.device)
            return
        if config.command.startswith(("record-", "recognition-")):
            print(json.dumps(await request(config), indent=2))
            return
        with locked_state(config.state_dir):
            identity = load_identity(config.state_dir)
            store = await open_store(config.state_dir)
            if config.command == "pair":
                await pair(config, identity, store)
            else:
                await service(config, identity, store)
    finally:
        for sig in registered:
            loop.remove_signal_handler(sig)


async def service(config, identity, store, *, owner=None, control_factory=ControlServer):
    owner = owner or SharedCapture(config.device)
    recorder = Recorder(owner, config.state_dir)
    recognition = Recognition(owner, identity, state_dir=config.state_dir)
    control = control_factory(config.state_dir, recorder)
    control.recognition = recognition
    meters = Meters()
    owner.observers.add(meters)
    health = SourceHealth(meters, owner, recorder, config.state_dir)
    tools = ToolsServer(config.state_dir, identity, meters, health)
    running = None
    failed = None
    try:
        await recognition.start()
        await control.start()
        await health.start()
        await tools.start()
        running = asyncio.create_task(run(
            config, identity, store,
            client_factory=lambda *args: make_client(*args, clock=owner.clock),
            bridge_factory=lambda client, device: SourceBridge(client, device, owner=owner),
            health=health,
        ))
        failed = asyncio.create_task(wait_events(owner.failed, recorder.failed, control.failed))
        await asyncio.wait((running, failed), return_when=asyncio.FIRST_COMPLETED)
        for component in (owner, recorder, control):
            if component.failure is not None:
                raise component.failure
        await running
    finally:
        async def stop_network():
            tasks = [task for task in (running, failed) if task is not None]
            for task in tasks:
                task.cancel()
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for result in results:
                if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
                    if result is not primary:
                        raise result

        primary = sys.exception()
        await cleanup_async([
            ("source tools shutdown", tools.close),
            ("source health shutdown", health.close),
            ("recording control close", control.close),
            ("recognition shutdown", recognition.close),
            ("recording shutdown", recorder.close),
            ("network shutdown", stop_network),
            ("shared input shutdown", owner.close),
        ], primary=primary)
        owner.observers.discard(meters)


def main(argv=None):
    config = parse_args(argv)
    # Only our deliberately safe operational messages enter the journal.
    logging.getLogger().addHandler(logging.NullHandler())
    logger = logging.getLogger("sendspin_karaoke_source")
    logger.setLevel(logging.INFO)
    logger.propagate = False
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s: %(message)s"))
    logger.addHandler(handler)
    try:
        if config.command == "devices":
            devices = discover()
            for device in devices:
                print(f"{device.selector}\t{device.name}")
            if not devices:
                raise SourceError("No stereo ALSA capture inputs found; check USB and service-user audio access.")
        else:
            asyncio.run(dispatch(config))
        return 0
    except (KeyboardInterrupt, asyncio.CancelledError):
        return 0
    except SourceError as error:
        LOG.error("%s", error)
        return 2
    except (*TRANSPORT_ERRORS, PairingError) as error:
        LOG.error(
            "Source %s failed (%s). Check server reachability/state access; "
            "a reset server may require explicit re-pairing.",
            config.command, error_classes(error),
        )
        return 1
    except (Exception, BaseExceptionGroup) as error:
        LOG.error(
            "Unexpected source %s failure (%s), code 3; stopping without retry. "
            "No exception payload or credentials were logged.",
            config.command, error_classes(error),
        )
        return 3
    finally:
        logger.removeHandler(handler)


if __name__ == "__main__":
    sys.exit(main())
