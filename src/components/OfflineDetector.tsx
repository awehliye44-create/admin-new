import { useState, useEffect, useCallback } from "react";
import noInternetImg from "@/assets/no-internet-connection.png";

export const OfflineDetector = () => {
  const [isOffline, setIsOffline] = useState(false);

  const verifyConnectivity = useCallback(async () => {
    try {
      // Ping Supabase health endpoint with cache-bust
      await fetch(`${import.meta.env.VITE_SUPABASE_URL}/rest/v1/`, {
        method: "HEAD",
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      setIsOffline(false);
    } catch {
      setIsOffline(true);
    }
  }, []);

  useEffect(() => {
    const goOffline = () => verifyConnectivity();
    const goOnline = () => setIsOffline(false);

    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);

    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, [verifyConnectivity]);

  if (!isOffline) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background">
      <img
        src={noInternetImg}
        alt="No internet connection"
        className="w-64 h-64 mb-6"
      />
      <h2 className="text-xl font-semibold text-foreground mb-2">
        No Internet Connection
      </h2>
      <p className="text-muted-foreground text-sm text-center max-w-xs">
        Please check your network connection and try again.
      </p>
      <button
        onClick={() => verifyConnectivity()}
        className="mt-6 px-6 py-2 rounded-md bg-primary text-primary-foreground font-medium text-sm hover:opacity-90 transition-opacity"
      >
        Retry
      </button>
    </div>
  );
};
