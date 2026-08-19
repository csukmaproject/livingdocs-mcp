package fixture;

class CalculatorTest {
    void testSquare() {
        Calculator c = new Calculator();
        if (c.square(2) != 4) {
            throw new RuntimeException("fail");
        }
    }
}
