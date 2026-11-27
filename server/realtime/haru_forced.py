"""Forced text for Haru-4B: make the duplex model say a given sentence in its own voice and timing.

Haru's public session has no way to steer it mid-call (start() and step() only; `speak_first` only bans the silent
tokens for one frame, it does not choose words). Every frame, though, Haru samples one text token and conditions its
next frames on it, and the audio follows the text stream. So this session replaces the sampled text token with the
next token of a sentence it was given (after an EOP, the token that ends a pause and starts a turn): the model then
"has said" those words and its voice should follow. Whether it does — and how faithfully — is the deciding test of the
proposal (server/realtime/haru_forced_text.py measures it).

It patches nothing on disk: the sampler `haru_mlx.session.sample_token` is wrapped for the one frame that is forced.
Haru-4B and haru_mlx are Apache-2.0 (higurashi); see docs/haru.md.
"""

from __future__ import annotations

from collections import deque


def forced_session_class():
    """DuplexSession with force(); imported lazily so this module loads without MLX."""
    import mlx.core as mx
    import haru_mlx.session as hs
    from haru_mlx.session import DuplexSession

    class ForcedSession(DuplexSession):
        def __init__(self, *a, **k):
            super().__init__(*a, **k)
            self.forced: deque[int] = deque()

        def force(self, text: str, pace: int = 0) -> int:
            """Queue `text` to be said: EOP, then its tokens, with `pace` PAD frames after each. Returns the frames queued."""
            ids = self.model.tokenizer.encode(" " + text.strip(), add_special_tokens=False).ids
            seq = [self.eop_id]
            for t in ids:
                seq.append(t)
                seq.extend([self.pad_id] * pace)
            self.forced.extend(seq)
            return len(seq)

        def _emit(self, hidden, started):
            if not self.forced:
                return super()._emit(hidden, started)
            tid = self.forced.popleft()
            original = hs.sample_token

            def forced(*a, **k):
                t = original(*a, **k)
                return mx.full(t.shape, tid, dtype=t.dtype)

            hs.sample_token = forced
            try:
                return super()._emit(hidden, started)
            finally:
                hs.sample_token = original

    return ForcedSession
