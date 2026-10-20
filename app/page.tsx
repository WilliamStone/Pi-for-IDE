import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { ServerRestartBanner } from "@/components/ServerRestartBanner";
import { I18nProvider } from "@/hooks/useI18n";

export default function Home() {
  return (
    <Suspense>
      <I18nProvider>
        <AppShell />
        <ServerRestartBanner />
      </I18nProvider>
    </Suspense>
  );
}
