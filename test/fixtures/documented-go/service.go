// Package fixture exercises Go extraction: functions, methods, structs,
// interfaces, and type aliases documented with // doc-comment runs.
//
// @purpose Fixture package covering Go's documentable declaration shapes.
// @audience technical

package fixture

// Add returns the sum of a and b.
//
// @purpose Adds two integers together.
// @requirement REQ-100
// @contract pre: a and b are finite ints.
//   post: returns a + b.
//   side-effects: none.
// @audience technical
func Add(a, b int) int {
	return a + b
}

func Subtract(a, b int) int {
	return a - b
}

// Multiplier documents a widget capable of scaling a value.
//
// @purpose A named scaling factor.
// @audience technical
type Multiplier struct {
	Factor int
}

// Scale returns v multiplied by the receiver's Factor.
//
// @purpose Scales v by the receiver's Factor.
// @contract post: returns v * m.Factor.
//   side-effects: none.
// @audience technical
func (m Multiplier) Scale(v int) int {
	return v * m.Factor
}

// Shape is anything with an Area.
//
// @purpose Common interface for two-dimensional shapes.
// @audience technical
type Shape interface {
	Area() float64
}

// UserID is a named alias over string, not a struct or interface.
//
// @purpose Distinguishes a raw string from a validated user identifier.
// @audience technical
type UserID = string

type internalCounter struct {
	n int
}

// This comment has a blank line after it, so it must NOT attach to Gadget below.

type Gadget struct {
	Name string
}

// Grouped type block -- v1 deliberately skips these rather than guessing
// which spec inside is "the" declaration.
type (
	GroupedA struct{}
	GroupedB interface{}
)
