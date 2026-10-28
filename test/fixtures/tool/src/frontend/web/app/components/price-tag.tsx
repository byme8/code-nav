import { usePrice } from "../services/price-service";

const MAX_DIGITS = 2;

interface PriceTagProps {
  id: string;
}

function formatAmount(amount: number): string {
  return amount.toFixed(MAX_DIGITS);
}

export const PriceTag = ({ id }: PriceTagProps) => {
  const price = usePrice(id);
  if (price === null) return null;
  return (
    <span>
      {formatAmount(price.primaryAmount)} {price.currency}
    </span>
  );
};
