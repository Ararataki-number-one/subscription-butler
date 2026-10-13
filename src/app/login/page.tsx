// Modified for 订阅管家: product branding and login copy.
import { KeyRound, Layers3 } from "lucide-react";
import { LoginForm } from "@/components/auth/login-form";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh lg:grid-cols-[minmax(0,1fr)_30rem]">
      <section className="hidden flex-col justify-between bg-primary p-10 text-primary-foreground lg:flex xl:p-14">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary-foreground/12 ring-1 ring-primary-foreground/20">
            <Layers3 aria-hidden="true" className="size-5" />
          </div>
          <span className="text-sm font-semibold">订阅管家</span>
        </div>
        <div className="max-w-xl">
          <h2 className="text-4xl font-semibold leading-tight tracking-tight xl:text-5xl">
            订阅、收款和续费，一处看清。
          </h2>
          <p className="mt-5 max-w-md text-sm leading-7 text-primary-foreground/72">
            管理 Business 账号与 Pro 拼车，核对成本和收益，及时处理到期续费。
          </p>
        </div>
        <p className="text-xs text-primary-foreground/55">本地订阅管理软件</p>
      </section>

      <section className="flex items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Layers3 aria-hidden="true" className="size-4" />
            </div>
            <span className="text-sm font-semibold">订阅管家</span>
          </div>
          <Card className="w-full">
            <CardHeader>
              <div className="mb-3 flex size-9 items-center justify-center rounded-lg bg-accent text-accent-foreground">
                <KeyRound aria-hidden="true" className="size-4" />
              </div>
              <CardTitle as="h1" className="text-xl">
                访问验证
              </CardTitle>
              <CardDescription className="leading-6">
                输入访问密钥，打开你的订阅账本。
              </CardDescription>
            </CardHeader>
            <CardContent>
              <LoginForm />
            </CardContent>
          </Card>
        </div>
      </section>
    </main>
  );
}
