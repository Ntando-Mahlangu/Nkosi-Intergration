import { Route, Routes } from "react-router-dom";
import Portfolio from "./Portfolio";
import ProjectForm from "./ProjectForm";
import ProjectDetail from "./ProjectDetail";
import { ProgrammesList, ProgrammeView } from "./Programmes";
import "./projects.css";

/** Projects & Programmes module — routes under /projects/*. */
export default function ProjectsModule() {
  return (
    <Routes>
      <Route index element={<Portfolio />} />
      <Route path="new" element={<ProjectForm />} />
      <Route path="programmes" element={<ProgrammesList />} />
      <Route path="programmes/:id" element={<ProgrammeView />} />
      <Route path=":id" element={<ProjectDetail />} />
      <Route path=":id/edit" element={<ProjectForm />} />
    </Routes>
  );
}
