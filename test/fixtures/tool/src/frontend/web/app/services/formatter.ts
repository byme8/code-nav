export interface Formatter {
  format(amount: number): string;
}

export class PlainFormatter implements Formatter {
  format(amount: number): string {
    return amount.toFixed(2);
  }
}

export class CurrencyFormatter implements Formatter {
  constructor(private readonly currency: string) {}

  format(amount: number): string {
    return `${amount.toFixed(2)} ${this.currency}`;
  }
}
