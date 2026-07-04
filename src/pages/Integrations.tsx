import { Navigate } from "react-router-dom";

/** Legacy route — redirects to the SSOT Payment Providers page. */
export default function Integrations() {
  return <Navigate to="/payment-providers" replace />;
}
