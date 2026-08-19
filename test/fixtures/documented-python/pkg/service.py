"""Fixture package used to test Python extraction.

@purpose Fixture package covering Python's documentable declaration shapes.
@audience technical
"""

import functools


def add(a, b):
    """Adds two integers together.

    @purpose Adds two integers together.
    @requirement REQ-300
    @contract pre: a and b are numbers.
      post: returns a + b.
      side-effects: none.
    @audience technical
    """
    return a + b


def subtract(a, b):
    # plain comment, not a docstring -- must be treated as undocumented
    return a - b


class Widget:
    """A documented widget.

    @purpose A named widget with a value.
    @audience technical
    """

    def __init__(self, value):
        self.value = value


@functools.lru_cache
def cached_double(n):
    """Doubles n, memoized.

    @purpose Returns n doubled, cached for repeat calls.
    @audience technical
    """
    return n * 2


class Gadget:
    pass
