import TipModal from "@/components/TipModal";
import TransactionList from "@/components/TransactionList";

interface Props {
  workerName: string;
  walletAddress: string | null | undefined;
}

export function WorkerTipSection({ workerName, walletAddress }: Props) {
  if (!walletAddress) {
    return (
      <p className="text-sm text-gray-500 italic">
        This worker hasn&apos;t connected a wallet yet.
      </p>
    );
  }
  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-gray-700">Support this worker</p>
          <p className="text-xs text-gray-500 mt-0.5">
            Send XLM directly to their Stellar wallet
          </p>
        </div>
        <TipModal workerName={workerName} walletAddress={walletAddress} />
      </div>
      <TransactionList walletAddress={walletAddress} />
    </>
  );
}
