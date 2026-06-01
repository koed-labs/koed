import threading
import time
import unittest

from priority_scheduler import (
    BACKGROUND_PRIORITY,
    INTERACTIVE_PRIORITY,
    EmbeddingPriorityScheduler,
    normalize_embedding_priority,
)


class EmbeddingPrioritySchedulerTest(unittest.TestCase):
    def wait_for_snapshot(
        self,
        scheduler: EmbeddingPriorityScheduler,
        *,
        interactive: int,
        background: int,
        timeout: float = 5,
    ) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            snapshot = scheduler.snapshot()
            if (
                snapshot.waiting_interactive == interactive
                and snapshot.waiting_background == background
            ):
                return
            time.sleep(0.01)
        snapshot = scheduler.snapshot()
        self.fail(
            "scheduler waiters did not reach expected counts; "
            f"expected interactive={interactive} background={background}, "
            f"got interactive={snapshot.waiting_interactive} "
            f"background={snapshot.waiting_background}"
        )

    def test_normalizes_unknown_or_blank_priority_to_interactive(self) -> None:
        self.assertEqual(normalize_embedding_priority(None), INTERACTIVE_PRIORITY)
        self.assertEqual(normalize_embedding_priority(""), INTERACTIVE_PRIORITY)
        self.assertEqual(normalize_embedding_priority("unknown"), INTERACTIVE_PRIORITY)
        self.assertEqual(normalize_embedding_priority("question"), INTERACTIVE_PRIORITY)
        self.assertEqual(normalize_embedding_priority("background"), BACKGROUND_PRIORITY)

    def test_interactive_waiter_gets_next_slot_before_background_waiter(self) -> None:
        scheduler = EmbeddingPriorityScheduler()
        active_acquired = threading.Event()
        background_waiting = threading.Event()
        interactive_waiting = threading.Event()
        release_active = threading.Event()
        acquired_order: list[str] = []

        def hold_active_slot() -> None:
            with scheduler.slot(BACKGROUND_PRIORITY):
                active_acquired.set()
                release_active.wait(timeout=5)

        def wait_for_background_slot() -> None:
            background_waiting.set()
            with scheduler.slot(BACKGROUND_PRIORITY):
                acquired_order.append(BACKGROUND_PRIORITY)

        def wait_for_interactive_slot() -> None:
            interactive_waiting.set()
            with scheduler.slot(INTERACTIVE_PRIORITY):
                acquired_order.append(INTERACTIVE_PRIORITY)

        active = threading.Thread(target=hold_active_slot)
        background = threading.Thread(target=wait_for_background_slot)
        interactive = threading.Thread(target=wait_for_interactive_slot)

        active.start()
        self.assertTrue(active_acquired.wait(timeout=5))
        background.start()
        self.assertTrue(background_waiting.wait(timeout=5))
        self.wait_for_snapshot(scheduler, interactive=0, background=1)
        interactive.start()
        self.assertTrue(interactive_waiting.wait(timeout=5))
        self.wait_for_snapshot(scheduler, interactive=1, background=1)

        release_active.set()
        active.join(timeout=5)
        background.join(timeout=5)
        interactive.join(timeout=5)

        self.assertFalse(active.is_alive())
        self.assertFalse(background.is_alive())
        self.assertFalse(interactive.is_alive())
        self.assertEqual(acquired_order, [INTERACTIVE_PRIORITY, BACKGROUND_PRIORITY])


if __name__ == "__main__":
    unittest.main()
