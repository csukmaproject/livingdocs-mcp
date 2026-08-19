package fixture;

/**
 * @purpose Fixture service demonstrating Java extraction.
 * @requirement REQ-200
 * @contract pre: a and b are finite ints.
 *   post: returns a + b.
 *   side-effects: none.
 * @audience technical
 */
public class Service {
    public int add(int a, int b) {
        return a + b;
    }
}

/**
 * @purpose Common interface for shapes with an area.
 * @audience technical
 */
interface Shape {
    double area();
}

/**
 * @purpose The lifecycle states a fixture entity can be in.
 * @audience technical
 */
enum Status {
    ACTIVE,
    INACTIVE
}

// Plain comment, not Javadoc -- Widget must be treated as undocumented.
class Widget {
    int value;
}

class Gadget {
    int value;
}
