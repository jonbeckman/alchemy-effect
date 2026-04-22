import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { highlightTS } from "../marketing/highlightTS";

/**
 * Showcase for the "Compose Effects and Layers..." (Effect-pilled) section.
 *
 * Single terminal-chromed card with two tabs in the header:
 *   - IAM bindings   — `S3.GetObject.bind(Photos)` etc → permissions + env vars
 *   - Event sources  — `DynamoDB.stream(Jobs).process(...)` → EventSourceMapping
 *
 * Each panel is a 2-col split (code + stylized "generated artifact" panel) on
 * desktop and stacks vertically with a "↓ generates" cue on mobile. Nothing
 * relies on SVG arrows that fall apart on narrow screens — meaning is
 * carried by labelled rows, pills, and box nodes.
 *
 * Auto-cycles tabs every CYCLE_MS while in view; tap to pin.
 */

type Tab = "iam" | "stream";

const CYCLE_MS = 7000;

const IAM_CODE = `Effect.gen(function* () {
  const getPhoto = yield* S3.GetObject.bind(Photos);
  const putJob   = yield* DynamoDB.PutItem.bind(Jobs);
  // handler uses getPhoto / putJob …
});`;

const STREAM_CODE = `Effect.gen(function* () {
  yield* DynamoDB.stream(Jobs).process(handler);
});`;

interface Permission {
  icon: string;
  action: string;
  target: string;
}

const PERMISSIONS: Permission[] = [
  { icon: "logos:aws-s3", action: "s3:GetObject", target: "Photos/*" },
  { icon: "logos:aws-dynamodb", action: "dynamodb:PutItem", target: "Jobs" },
];

interface EnvVar {
  name: string;
  value: string;
}

const ENV_VARS: EnvVar[] = [
  { name: "PHOTOS_BUCKET", value: "arn:aws:s3:::photos-…" },
  { name: "JOBS_TABLE", value: "arn:aws:dynamodb:…:table/Jobs-…" },
];

export default function EffectPilledShowcase() {
  const [tab, setTab] = useState<Tab>("iam");
  const [pinned, setPinned] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pinned) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = () => {
      timer = setTimeout(() => {
        if (cancelled) return;
        setTab((t) => (t === "iam" ? "stream" : "iam"));
      }, CYCLE_MS);
    };

    const obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            schedule();
          } else if (timer) {
            clearTimeout(timer);
            timer = null;
          }
        }
      },
      { threshold: 0.3 },
    );
    if (wrapRef.current) obs.observe(wrapRef.current);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      obs.disconnect();
    };
  }, [tab, pinned]);

  const onTab = (next: Tab) => {
    setPinned(true);
    setTab(next);
  };

  const iamHtml = highlightTS(IAM_CODE);
  const streamHtml = highlightTS(STREAM_CODE);

  return (
    <div ref={wrapRef} className="eff-showcase">
      <div className="eff-showcase__chrome">
        <div className="eff-showcase__header">
          <span
            className="alc-code-block__dot"
            style={{ background: "var(--alc-danger)" }}
          />
          <span
            className="alc-code-block__dot"
            style={{ background: "var(--alc-warn)" }}
          />
          <span
            className="alc-code-block__dot"
            style={{ background: "var(--alc-accent-bright)" }}
          />
          <div className="eff-showcase__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "iam"}
              className="eff-showcase__tab"
              data-active={tab === "iam"}
              onClick={() => onTab("iam")}
            >
              IAM bindings
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "stream"}
              className="eff-showcase__tab"
              data-active={tab === "stream"}
              onClick={() => onTab("stream")}
            >
              Event sources
            </button>
          </div>
        </div>

        <div className="eff-showcase__body">
          {/* IAM panel — keep the permissions/env stagger reset on each entry
              by keying the panel on the tab so React remounts it. */}
          <div
            className="eff-showcase__panel"
            hidden={tab !== "iam"}
            role="tabpanel"
            aria-label="IAM bindings"
          >
            {tab === "iam" && (
              <IamPanel codeHtml={iamHtml} key={`iam-${pinned ? "p" : "a"}`} />
            )}
          </div>
          <div
            className="eff-showcase__panel"
            hidden={tab !== "stream"}
            role="tabpanel"
            aria-label="Event sources"
          >
            {tab === "stream" && (
              <StreamPanel
                codeHtml={streamHtml}
                key={`stream-${pinned ? "p" : "a"}`}
              />
            )}
          </div>
        </div>
      </div>
      <div className="eff-showcase__hint" aria-hidden>
        {pinned ? <span>tap a tab to switch</span> : <span>cycling · tap to pin</span>}
      </div>
    </div>
  );
}

function IamPanel({ codeHtml }: { codeHtml: string }) {
  return (
    <div className="eff-showcase__split">
      <div className="eff-showcase__code">
        <pre
          className="eff-showcase__pre"
          dangerouslySetInnerHTML={{ __html: codeHtml }}
        />
      </div>
      <div className="eff-showcase__artifact">
        <div className="eff-showcase__group">
          <div className="eff-showcase__group-title">Permissions</div>
          {PERMISSIONS.map((p, i) => (
            <div
              className="eff-showcase__perm"
              key={p.action}
              style={{ animationDelay: `${120 + i * 120}ms` }}
            >
              <Icon
                icon={p.icon}
                width={20}
                height={20}
                aria-hidden
                className="eff-showcase__perm-icon"
              />
              <span className="eff-showcase__perm-action">{p.action}</span>
              <span className="eff-showcase__perm-arrow" aria-hidden>
                →
              </span>
              <span className="eff-showcase__perm-target">{p.target}</span>
            </div>
          ))}
        </div>
        <div className="eff-showcase__group">
          <div className="eff-showcase__group-title">Environment</div>
          <div className="eff-showcase__envs">
            {ENV_VARS.map((e, i) => (
              <div
                className="eff-showcase__env"
                key={e.name}
                style={{
                  animationDelay: `${360 + i * 100}ms`,
                }}
              >
                <span className="eff-showcase__env-name">{e.name}</span>
                <span className="eff-showcase__env-eq" aria-hidden>
                  =
                </span>
                <span className="eff-showcase__env-value">{e.value}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StreamPanel({ codeHtml }: { codeHtml: string }) {
  return (
    <div className="eff-showcase__split">
      <div className="eff-showcase__code">
        <pre
          className="eff-showcase__pre"
          dangerouslySetInnerHTML={{ __html: codeHtml }}
        />
      </div>
      <div className="eff-showcase__artifact">
        <div className="eff-showcase__group">
          <div className="eff-showcase__group-title">Wired event source</div>
          <div className="eff-showcase__flow">
            <div className="eff-showcase__node" style={{ animationDelay: "120ms" }}>
              <Icon
                icon="logos:aws-dynamodb"
                width={22}
                height={22}
                aria-hidden
              />
              <div className="eff-showcase__node-label">Jobs</div>
              <div className="eff-showcase__node-sub">DynamoDB.Table</div>
            </div>
            <div
              className="eff-showcase__edge"
              data-label="stream"
              style={{ animationDelay: "260ms" }}
              aria-hidden
            />
            <div
              className="eff-showcase__node eff-showcase__node--accent"
              style={{ animationDelay: "320ms" }}
            >
              <Icon
                icon="logos:aws-lambda"
                width={22}
                height={22}
                aria-hidden
              />
              <div className="eff-showcase__node-label">EventSourceMapping</div>
              <div className="eff-showcase__node-sub">created by alchemy</div>
            </div>
            <div
              className="eff-showcase__edge"
              data-label="invoke"
              style={{ animationDelay: "440ms" }}
              aria-hidden
            />
            <div
              className="eff-showcase__node"
              style={{ animationDelay: "500ms" }}
            >
              <Icon
                icon="mdi:function-variant"
                width={22}
                height={22}
                aria-hidden
              />
              <div className="eff-showcase__node-label">handler</div>
              <div className="eff-showcase__node-sub">your function</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
