using Shop.Api.Models;

namespace Shop.Services.Pricing;

public class PriceCalculator : IPriceCalculator
{
    private readonly decimal _rate;

    public PriceCalculator(decimal rate)
    {
        _rate = rate;
    }

    public string Currency { get; init; } = "USD";

    public PriceOutput ComputePrimaryAmount(decimal amount)
    {
        return new PriceOutput(amount * _rate, Currency);
    }

    public PriceOutput ComputePrimaryAmount(decimal amount, decimal discount)
    {
        var discounted = amount - discount;
        return ComputePrimaryAmount(discounted);
    }

    public record Breakdown(decimal Base, decimal Tax);
}
