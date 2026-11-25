import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { AuthProvider, LookupsProvider, ToastProvider, useAuth } from "./lib/app-state";
import "./styles.css";

function WithLookups({ children }: { children: React.ReactNode }) {
  const { me } = useAuth();
  // Lookups are only loaded once signed in; keyed by user so switching accounts reloads them.
  return me ? <LookupsProvider key={me.user.id}>{children}</LookupsProvider> : <>{children}</>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <AuthProvider>
          <WithLookups>
            <App />
          </WithLookups>
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
