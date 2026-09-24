import { Link } from "@tanstack/react-router";
import { useApi, type Profile } from "@/lib/api";
import { Panel } from "@/ui/kit";

export function SetupChecklist({ llmConfigured }: { llmConfigured: boolean }) {
  const profile = useApi<Profile>(["profile"], "/api/v1/settings/profile");
  const p = profile.data;
  if (!p || (p.location?.trim() && p.targetRoles?.length &&
    [p.northStar, p.scoutBrief, p.identityMarkdown, p.masterResumeMarkdown].some(v => v?.trim()))) return null;
  return <div className="mb-5"><Panel title="Set up your job search">
    <p className="text-[13px] text-muted mb-3">Start with your preferences so the matches reflect what you want. You can use the tracker without AI.</p>
    <ol className="grid md:grid-cols-3 gap-4 text-[13px]">
      <li><Link to="/settings" search={{ tab: "profile" }} className="text-accent font-medium">1. Set your profile</Link>
        <p className="text-muted mt-1">Add your location, target roles and what you want next. A resume helps with evaluations and drafts; contact details are optional.</p></li>
      <li><Link to="/settings" search={{ tab: "gate" }} className="text-accent font-medium">2. Review your filters</Link>
        <p className="text-muted mt-1">Check title and location rules, then choose boards in <Link to="/sources" className="text-accent">Sources</Link>. Start by reviewing listings in <Link to="/pipeline" className="text-accent">Pipeline</Link>.</p></li>
      <li><Link to="/settings" search={{ tab: "ai" }} className="text-accent font-medium">3. Choose AI models (optional)</Link>
        <p className="text-muted mt-1">{llmConfigured ? "A key is configured. Select and test your models, then set daily limits." : "Add a model key to your server configuration and restart, then select and test models. Scanning works without a key."}</p></li>
    </ol>
  </Panel></div>;
}
