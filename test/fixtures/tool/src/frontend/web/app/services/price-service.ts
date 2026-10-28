import { useGetPriceQuery } from "../graphql/price.gql";

export function usePrice(id: string) {
  return useGetPriceQuery({ variables: { id } }).data?.price ?? null;
}
