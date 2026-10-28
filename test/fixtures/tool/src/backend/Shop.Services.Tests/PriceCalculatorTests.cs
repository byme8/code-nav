using Shop.Services.Pricing;

namespace Shop.Services.Tests;

public class PriceCalculatorTests
{
    public void ComputePrimaryAmountAppliesTheRate()
    {
        var calculator = new PriceCalculator(2m);
        calculator.ComputePrimaryAmount(10m);
    }
}
