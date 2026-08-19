package fixture

func Widgetize(name string) string {
	return name + "-widget"
}

type Counter struct {
	n int
}

func (c *Counter) Increment() int {
	c.n++
	return c.n
}
