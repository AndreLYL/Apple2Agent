/** Search normalization only; never use fuzzy text to authorize a recipient. */
export function searchText(value: string) {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}
