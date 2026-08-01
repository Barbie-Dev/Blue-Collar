import { useCallback, useState } from "react";
import type { Worker } from "@/types";

interface UseContactCardOptions {
  onContactClick?: (workerId: string) => void;
}

export function useContactCard(options?: UseContactCardOptions) {
  const [contactedIds, setContactedIds] = useState<Set<string>>(new Set());

  const handleContactClick = useCallback(
    (workerId: string) => {
      setContactedIds((prev) => new Set([...prev, workerId]));
      options?.onContactClick?.(workerId);
    },
    [options]
  );

  const isContactedBefore = useCallback(
    (workerId: string) => contactedIds.has(workerId),
    [contactedIds]
  );

  const clearContactHistory = useCallback(() => {
    setContactedIds(new Set());
  }, []);

  return {
    handleContactClick,
    isContactedBefore,
    clearContactHistory,
    contactedIds: Array.from(contactedIds),
  };
}
