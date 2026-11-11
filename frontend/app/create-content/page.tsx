import type { Metadata } from "next";
import { CreateContentForm } from "../../components/create-content-form";
import { PageFrame } from "../../components/page-frame";

export const metadata: Metadata = { title: "Create Content" };

export default function CreateContentPage() {
  return (
    <PageFrame title="Create Content" description="Turn your brief into a social post or a short video script.">
      <CreateContentForm />
    </PageFrame>
  );
}
