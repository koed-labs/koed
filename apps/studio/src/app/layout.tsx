import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { BuildViewProvider } from "@/components/BuildViewProvider";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";

export const metadata: Metadata = {
  title: "Koed Studio",
  description: "Personal workspace for your Koed activity"
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body className="flex h-screen overflow-hidden bg-background text-foreground select-none">
        <ThemeProvider>
          <BuildViewProvider>{children}</BuildViewProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
