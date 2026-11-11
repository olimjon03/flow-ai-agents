import {
  ChartNoAxesColumnIncreasing, Film, Folder, House, Image, Monitor, Pencil, Send, Settings, Sparkle,
} from "lucide-react";

export const dashboard = { label: "Dashboard", href: "/", icon: House };
export const createContent = { label: "Create Content", href: "/create-content", icon: Pencil };
export const tools = [
  { slug: "ai-agents", label: "AI Agents", icon: Sparkle, description: "Use specialized AI agents to ideate, draft, and refine content.", empty: "Specialized agents are not configured yet." },
  { slug: "projects", label: "Projects", icon: Folder, description: "Organize content, assets, and campaigns in one place.", empty: "Project storage will be added in a future phase." },
  { slug: "storyboard", label: "Storyboard", icon: Film, description: "Plan and structure your video content, scene by scene.", empty: "Scene editing will be added in a future phase. You can generate a short script in Create Content." },
  { slug: "media-library", label: "Media Library", icon: Image, description: "Store and manage your images, videos, and other media assets.", empty: "Media storage will be added in a future phase." },
  { slug: "publishing", label: "Publishing", icon: Send, description: "Prepare and publish content to your chosen platforms.", empty: "Publishing integrations will be added in a future phase." },
  { slug: "analytics", label: "Analytics", icon: ChartNoAxesColumnIncreasing, description: "Understand what’s working and inform your next creative move.", empty: "Analytics will be available once publishing data is connected." },
];

export const aiOffice = { label: "AI Office", href: "/ai-office", icon: Monitor };
export const mediaStudio = { label: "Media Studio", href: "/media-studio", icon: Film };
export const settings = { label: "Settings", href: "/settings", icon: Settings };
export const navigation = [
  dashboard,
  createContent,
  mediaStudio,
  ...tools.flatMap((tool) => {
    const link = { ...tool, href: `/${tool.slug}` };
    return tool.slug === "ai-agents" ? [link, aiOffice] : [link];
  }),
  settings,
];
