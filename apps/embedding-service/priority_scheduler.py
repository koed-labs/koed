from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from threading import Condition

INTERACTIVE_PRIORITY = "interactive"
BACKGROUND_PRIORITY = "background"

_PRIORITY_RANK = {
    INTERACTIVE_PRIORITY: 0,
    "question": 0,
    "foreground": 0,
    BACKGROUND_PRIORITY: 10,
}


def normalize_embedding_priority(value: str | None) -> str:
    normalized = (value or INTERACTIVE_PRIORITY).strip().lower()
    if _PRIORITY_RANK.get(normalized, 0) == 0:
        return INTERACTIVE_PRIORITY
    return BACKGROUND_PRIORITY


@dataclass(frozen=True)
class SchedulerSnapshot:
    active: bool
    waiting_interactive: int
    waiting_background: int


class EmbeddingPriorityScheduler:
    def __init__(self) -> None:
        self._condition = Condition()
        self._active = False
        self._next_sequence = 0
        self._waiting: list[tuple[int, int, str]] = []

    @contextmanager
    def slot(self, priority: str | None) -> Iterator[None]:
        normalized = normalize_embedding_priority(priority)
        rank = _PRIORITY_RANK[normalized]
        with self._condition:
            sequence = self._next_sequence
            self._next_sequence += 1
            entry = (rank, sequence, normalized)
            self._waiting.append(entry)

            while self._active or entry != min(self._waiting):
                self._condition.wait()

            self._waiting.remove(entry)
            self._active = True

        try:
            yield
        finally:
            with self._condition:
                self._active = False
                self._condition.notify_all()

    def snapshot(self) -> SchedulerSnapshot:
        with self._condition:
            return SchedulerSnapshot(
                active=self._active,
                waiting_interactive=sum(1 for rank, _, _ in self._waiting if rank == 0),
                waiting_background=sum(1 for rank, _, _ in self._waiting if rank > 0),
            )
