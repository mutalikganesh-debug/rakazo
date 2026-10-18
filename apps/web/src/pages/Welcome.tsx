import { Trans } from "@lingui/react/macro";
import { ArrowRight } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { WindowChrome } from "./WindowChrome";

export function WelcomePage() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-full flex-col bg-background" data-rakazo-surface="welcome">
      <div className="app-drag flex gap-2 px-5 py-[18px]">
        <WindowChrome />
      </div>
      <main className="flex flex-1 flex-col items-center justify-center gap-11 px-5 pb-[90px]">
        <div className="flex items-center gap-[18px] sm:gap-[26px]">
          <div className="flex size-16 items-center justify-center gap-[9px] rounded-full bg-accent sm:size-[88px] sm:gap-[13px]">
            <span className="h-[17px] w-2 rounded-full bg-primary sm:h-6 sm:w-[11px]" />
            <span className="h-[17px] w-2 rounded-full bg-primary sm:h-6 sm:w-[11px]" />
          </div>
          <h1 className="text-[56px] leading-none tracking-[-0.03em] text-foreground sm:text-[76px]">
            Rakazo
          </h1>
        </div>
        <p className="max-w-[600px] text-center text-[27px] leading-[1.4] text-foreground/75">
          <Trans>
            Your team of always-on agents
            <br />
            that you can give real work to.
          </Trans>
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            onClick={() => navigate("/sign-up")}
            className="app-no-drag rounded-full bg-primary px-[34px] py-[15px] text-[19px] text-primary-foreground transition hover:bg-primary/90 hover:scale-[1.03] active:scale-[0.99] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <Trans>Sign up</Trans>
            <ArrowRight
              className="ms-2 inline-block align-[-2px]"
              size={18}
              strokeWidth={2}
              aria-hidden="true"
            />
          </button>
          <Link
            to="/sign-in"
            className="app-no-drag rounded-full px-[34px] py-[15px] text-[19px] text-foreground/75 underline-offset-2 transition hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <Trans>Sign in</Trans>
          </Link>
        </div>
      </main>
    </div>
  );
}
