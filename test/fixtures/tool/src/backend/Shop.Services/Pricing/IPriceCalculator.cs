using Shop.Api.Models;

namespace Shop.Services.Pricing;

public interface IPriceCalculator
{
    PriceOutput ComputePrimaryAmount(decimal amount);
}
