import type { Metadata } from "next";
import { Office } from "../../components/office/office";
import "./office.css";

export const metadata: Metadata = { title: "AI Office" };

export default function AiOfficePage() {
  return <Office />;
}
