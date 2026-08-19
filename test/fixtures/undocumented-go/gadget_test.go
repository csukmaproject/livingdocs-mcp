package fixture

import "testing"

func TestWidgetize(t *testing.T) {
	if Widgetize("x") != "x-widget" {
		t.Fatal("unexpected result")
	}
}
