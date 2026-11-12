import { notFound } from "next/navigation";
import { DailyVideoSettings } from "../../components/daily-video-settings";
import { PageFrame } from "../../components/page-frame";
import { settings, tools } from "../../lib/navigation";

type Props = { params: Promise<{ section: string }> };

export function generateStaticParams() {
  return [...tools.map(({ slug }) => ({ section: slug })), { section: "settings" }];
}

export const dynamicParams = false;

export async function generateMetadata({ params }: Props) {
  const { section } = await params;
  const title = section === "settings" ? settings.label : tools.find(({ slug }) => slug === section)?.label;
  return { title };
}

export default async function WorkspacePage({ params }: Props) {
  const { section } = await params;

  if (section === "settings") {
    return (
      <PageFrame title="Settings" description="Local workspace and generation configuration.">
        <DailyVideoSettings />
        <section className="panel section-panel" aria-labelledby="settings-title">
          <h2 id="settings-title" className="section-title">Generation</h2>
          <dl className="settings-list">
            <div><dt>Sample mode</dt><dd>Start the Python server without flags to generate from local templates.</dd></div>
            <div><dt>OpenAI mode</dt><dd>Set <code>OPENAI_API_KEY</code> in the Python environment and start the server with <code>--openai</code>.</dd></div>
            <div><dt>API endpoint</dt><dd>Set <code>FLOW_API_URL</code> in the Next.js server environment when Python runs at a different URL.</dd></div>
          </dl>
        </section>
      </PageFrame>
    );
  }

  const tool = tools.find(({ slug }) => slug === section);
  if (!tool) notFound();
  const Icon = tool.icon;

  return (
    <PageFrame title={tool.label} description={tool.description}>
      <section className="panel section-panel tool-empty">
        <Icon aria-hidden="true" size={40} strokeWidth={1.5} className="text-violet-300" />
        <p>{tool.empty}</p>
      </section>
    </PageFrame>
  );
}
