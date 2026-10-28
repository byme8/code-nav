export type PriceFieldsFragment = { primaryAmount: number; currency: string };

export type GetPriceQuery = { price: PriceFieldsFragment | null };

export function useGetPriceQuery(options: { variables: { id: string } }): { data: GetPriceQuery | undefined } {
  return { data: options.variables.id === "" ? undefined : { price: null } };
}
