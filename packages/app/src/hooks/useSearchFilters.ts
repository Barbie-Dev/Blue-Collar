import { useState, useCallback } from "react";

export interface SearchFilterOptions {
  categories?: string[];
  ratings?: string[];
  locations?: string[];
}

interface FilterState {
  categories: string[];
  ratings: string[];
  locations: string[];
}

export function useSearchFilters(initialFilters?: SearchFilterOptions) {
  const [filters, setFilters] = useState<FilterState>({
    categories: initialFilters?.categories ?? [],
    ratings: initialFilters?.ratings ?? [],
    locations: initialFilters?.locations ?? [],
  });

  const updateCategoryFilter = useCallback((categoryId: string, selected: boolean) => {
    setFilters((prev) => ({
      ...prev,
      categories: selected
        ? [...prev.categories, categoryId]
        : prev.categories.filter((id) => id !== categoryId),
    }));
  }, []);

  const updateRatingFilter = useCallback((ratingId: string, selected: boolean) => {
    setFilters((prev) => ({
      ...prev,
      ratings: selected
        ? [...prev.ratings, ratingId]
        : prev.ratings.filter((id) => id !== ratingId),
    }));
  }, []);

  const updateLocationFilter = useCallback((locationId: string, selected: boolean) => {
    setFilters((prev) => ({
      ...prev,
      locations: selected
        ? [...prev.locations, locationId]
        : prev.locations.filter((id) => id !== locationId),
    }));
  }, []);

  const clearAllFilters = useCallback(() => {
    setFilters({ categories: [], ratings: [], locations: [] });
  }, []);

  const hasActiveFilters =
    filters.categories.length > 0 ||
    filters.ratings.length > 0 ||
    filters.locations.length > 0;

  return {
    filters,
    updateCategoryFilter,
    updateRatingFilter,
    updateLocationFilter,
    clearAllFilters,
    hasActiveFilters,
  };
}
