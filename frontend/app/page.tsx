import Link from "next/link";
import { PageFrame } from "../components/page-frame";
import { createContent, tools } from "../lib/navigation";

export default function DashboardPage() {
  return (
    <PageFrame className="dashboard-page" title="Dashboard" description="Plan and create content in one workspace.">
      <section className="hero panel" aria-labelledby="hero-title">
        <div className="hero-copy">
          <h2 id="hero-title">Turn a brief into a draft</h2>
          <p>Go from an idea or brief to a ready-to-edit social post and video script with AI.</p>
          <Link className="primary-button" href={createContent.href}>Create Content</Link>
        </div>
      </section>
      <section className="mt-8" aria-labelledby="tools-title">
        <h2 id="tools-title" className="section-title mb-5">Workspace tools</h2>
        <div className="tools-grid">
          {tools.map(({ slug, label, icon: Icon, description }) => (
            <Link key={slug} href={`/${slug}`} className="tool-card panel">
              <Icon aria-hidden="true" size={32} strokeWidth={1.55} className="shrink-0 text-violet-300" />
              <div>
                <h3>{label}</h3>
                <p>{description}</p>
              </div>
            </Link>
          ))}
        </div>
      </section>
    </PageFrame>
  );
}
