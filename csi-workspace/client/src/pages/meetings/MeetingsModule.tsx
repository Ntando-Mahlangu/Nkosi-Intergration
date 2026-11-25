import { Route, Routes } from "react-router-dom";
import MeetingsList from "./MeetingsList";
import MeetingForm from "./MeetingForm";
import MeetingDetail from "./MeetingDetail";
import MeetingReview from "./MeetingReview";
import "./meetings.css";

export default function MeetingsModule() {
  return (
    <Routes>
      <Route index element={<MeetingsList />} />
      <Route path="new" element={<MeetingForm />} />
      <Route path=":id" element={<MeetingDetail />} />
      <Route path=":id/edit" element={<MeetingForm />} />
      <Route path=":id/review" element={<MeetingReview />} />
    </Routes>
  );
}
