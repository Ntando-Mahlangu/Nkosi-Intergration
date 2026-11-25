// TEMPORARY dev harness for module smoke testing — deleted after use.
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { AuthProvider, LookupsProvider, ToastProvider, useAuth } from "../../lib/app-state";
import { Layout } from "../../components/Layout";
import Login from "../Login";
import KnowledgeModule from "./KnowledgeModule";
import SearchPage from "./SearchPage";
import "../../styles.css";
function Inner() {
  const { me, loading } = useAuth();
  if (loading) return null;
  if (!me) return <Login />;
  return (
    <LookupsProvider>
      <Layout>
        <Routes>
          <Route path="/knowledge/*" element={<KnowledgeModule />} />
          <Route path="/search" element={<SearchPage />} />
          <Route path="*" element={<div>home</div>} />
        </Routes>
      </Layout>
    </LookupsProvider>
  );
}
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><BrowserRouter><ToastProvider><AuthProvider><Inner /></AuthProvider></ToastProvider></BrowserRouter></React.StrictMode>);
