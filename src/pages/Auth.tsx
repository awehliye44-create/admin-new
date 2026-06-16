import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Loader2,
  Mail,
  Lock,
  AlertCircle,
  CheckCircle,
  Eye,
  EyeOff,
  ShieldCheck,
  ShieldAlert,
} from 'lucide-react';
import { z } from 'zod';
import heroImage from '@/assets/auth-onecab-hero.jpg';

const authSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

const APP_VERSION = '1.0.0';

function BrandPanel() {
  return (
    <aside
      className="relative hidden lg:flex lg:w-[40%] xl:w-[42%] flex-col justify-between overflow-hidden text-white"
      style={{ backgroundColor: '#050B18' }}
    >
      {/* Hero image - bottom anchored, faded into dark */}
      <div className="absolute inset-0">
        <img
          src={heroImage}
          alt=""
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-full w-full object-cover object-bottom opacity-70"
        />
        {/* Top fade to deep black so brand text stays crisp */}
        <div
          className="absolute inset-0"
          style={{
            background:
              'linear-gradient(180deg, #050B18 0%, rgba(5,11,24,0.92) 35%, rgba(5,11,24,0.55) 65%, rgba(5,11,24,0.85) 100%)',
          }}
        />
        {/* Subtle yellow glow */}
        <div
          aria-hidden="true"
          className="absolute -top-20 -left-20 h-72 w-72 rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(244,196,48,0.18) 0%, transparent 70%)' }}
        />
      </div>

      {/* Content */}
      <div className="relative z-10 flex flex-col h-full p-12 xl:p-16">
        {/* Logo + wordmark */}
        <div>
          <div
            className="flex h-16 w-16 items-center justify-center rounded-2xl shadow-lg"
            style={{ backgroundColor: '#F4C430' }}
          >
            <span className="text-xl font-black tracking-tight text-black">OC</span>
          </div>

          <h1 className="mt-8 text-5xl xl:text-6xl font-black tracking-tight leading-none">
            <span className="text-white">ONE</span>
            <span style={{ color: '#F4C430' }}>CAB</span>
          </h1>
          <p className="mt-3 text-sm font-semibold tracking-[0.32em] text-white/70">
            ADMIN&nbsp;&nbsp;CONSOLE
          </p>

          <div className="mt-6 h-1 w-14 rounded-full" style={{ backgroundColor: '#F4C430' }} />

          <p className="mt-8 max-w-sm text-base leading-relaxed text-white/75">
            Manage drivers, bookings, dispatch and operations from one place.
          </p>
        </div>

        {/* Spacer pushes footer */}
        <div className="flex-1" />

        {/* Footer */}
        <div className="relative z-10 flex items-center gap-3 text-white/80">
          <ShieldCheck className="h-5 w-5" style={{ color: '#F4C430' }} aria-hidden="true" />
          <span className="text-sm font-medium tracking-wide">Secure. Reliable. Always.</span>
        </div>
      </div>
    </aside>
  );
}

function FormShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex min-h-dvh w-full"
      style={{ backgroundColor: '#050B18' }}
    >
      <BrandPanel />

      <main
        className="relative flex flex-1 items-center justify-center px-4 py-10 sm:px-8 lg:px-12"
        style={{ backgroundColor: '#F4F6FA' }}
      >
        {/* Compact mobile brand header */}
        <div className="absolute top-0 inset-x-0 lg:hidden">
          <div
            className="flex items-center justify-center gap-3 px-4 py-4"
            style={{ backgroundColor: '#050B18' }}
          >
            <div
              className="flex h-9 w-9 items-center justify-center rounded-lg"
              style={{ backgroundColor: '#F4C430' }}
            >
              <span className="text-xs font-black text-black">OC</span>
            </div>
            <div className="text-lg font-black tracking-tight">
              <span className="text-white">ONE</span>
              <span style={{ color: '#F4C430' }}>CAB</span>
              <span className="ml-2 text-[10px] font-semibold tracking-[0.3em] text-white/60">
                ADMIN
              </span>
            </div>
          </div>
        </div>

        <div className="w-full max-w-md pt-20 lg:pt-0">
          {children}

          <p className="mt-8 text-center text-xs text-slate-500">
            ONECAB Admin Console &nbsp;•&nbsp; Version {APP_VERSION}
          </p>
        </div>
      </main>
    </div>
  );
}

export default function Auth() {
  const navigate = useNavigate();
  const { user, isAdmin, isLoading, signIn, signOut } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetEmailSent, setResetEmailSent] = useState(false);

  useEffect(() => {
    if (!isLoading && user && isAdmin) {
      navigate('/', { replace: true });
    }
  }, [user, isAdmin, isLoading, navigate]);

  const validateForm = () => {
    try {
      authSchema.parse({ email, password });
      return true;
    } catch (err) {
      if (err instanceof z.ZodError) {
        setError(err.errors[0].message);
      }
      return false;
    }
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!validateForm()) return;

    setIsSubmitting(true);
    const { error } = await signIn(email, password);
    setIsSubmitting(false);

    if (error) {
      if (error.message.includes('Invalid login credentials')) {
        setError('Invalid email or password');
      } else if (error.message.includes('Email not confirmed')) {
        setError('Please confirm your email address before signing in');
      } else {
        setError(error.message);
      }
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email) {
      setError('Please enter your email address');
      return;
    }

    try {
      authSchema.shape.email.parse(email);
    } catch {
      setError('Please enter a valid email address');
      return;
    }

    setIsSubmitting(true);
    const resetUrl = `${window.location.origin}/auth/reset`;
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: resetUrl,
    });
    setIsSubmitting(false);

    if (error) setError(error.message);
    else setResetEmailSent(true);
  };

  if (isLoading) {
    return (
      <div
        className="flex min-h-dvh items-center justify-center"
        style={{ backgroundColor: '#050B18' }}
      >
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin" style={{ color: '#F4C430' }} />
          <p className="text-white/70">Loading...</p>
        </div>
      </div>
    );
  }

  // Logged in but not admin
  if (user && !isAdmin) {
    return (
      <FormShell>
        <Card className="border-0 rounded-2xl shadow-[0_20px_60px_-15px_rgba(15,23,42,0.15)] bg-white">
          <CardHeader className="text-center pt-10">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-50">
              <ShieldAlert className="h-8 w-8 text-red-500" />
            </div>
            <CardTitle className="text-2xl font-bold text-slate-900">Access Denied</CardTitle>
            <CardDescription className="text-slate-500">
              Your account is not approved for admin access.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center space-y-4 pb-10">
            <p className="text-sm text-slate-500">
              Logged in as <span className="font-medium text-slate-900">{user.email}</span>
            </p>
            <p className="text-sm text-slate-500">
              Please wait for an administrator to approve your access.
            </p>
            <Button
              onClick={signOut}
              variant="outline"
              className="w-full h-11 border-slate-200 text-slate-900 hover:bg-slate-50"
            >
              Sign Out
            </Button>
          </CardContent>
        </Card>
      </FormShell>
    );
  }

  // Forgot password
  if (showForgotPassword) {
    return (
      <FormShell>
        <Card className="border-0 rounded-2xl shadow-[0_20px_60px_-15px_rgba(15,23,42,0.15)] bg-white">
          <CardHeader className="pt-10">
            <div
              className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl"
              style={{ backgroundColor: '#FEF3C7' }}
            >
              <Mail className="h-6 w-6" style={{ color: '#B45309' }} />
            </div>
            <CardTitle className="text-2xl font-bold text-slate-900">Reset password</CardTitle>
            <CardDescription className="text-slate-500">
              {resetEmailSent
                ? 'Check your email for the reset link.'
                : 'Enter your email and we’ll send you a secure reset link.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="pb-10">
            {resetEmailSent ? (
              <div className="space-y-4">
                <Alert className="bg-emerald-50 border-emerald-200">
                  <CheckCircle className="h-4 w-4 text-emerald-600" />
                  <AlertDescription className="text-emerald-700">
                    Reset link sent. Check your inbox to continue.
                  </AlertDescription>
                </Alert>
                <Button
                  variant="outline"
                  className="w-full h-11 border-slate-200 text-slate-900 hover:bg-slate-50"
                  onClick={() => {
                    setShowForgotPassword(false);
                    setResetEmailSent(false);
                  }}
                >
                  Back to sign in
                </Button>
              </div>
            ) : (
              <form onSubmit={handleForgotPassword} className="space-y-5">
                {error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <div className="space-y-2">
                  <Label htmlFor="reset-email" className="text-slate-900 font-semibold text-sm">
                    Email
                  </Label>
                  <div className="relative">
                    <Mail className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                    <Input
                      id="reset-email"
                      type="email"
                      placeholder="you@onecab.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="pl-11 h-12 rounded-xl border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-[#F4C430] focus-visible:border-[#F4C430]"
                      disabled={isSubmitting}
                      autoComplete="email"
                    />
                  </div>
                </div>

                <Button
                  type="submit"
                  className="w-full h-12 rounded-xl text-base font-semibold text-black hover:opacity-95 shadow-sm"
                  style={{ backgroundColor: '#F4C430' }}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    'Send reset link'
                  )}
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  className="w-full text-slate-500 hover:text-slate-900"
                  onClick={() => setShowForgotPassword(false)}
                >
                  Back to sign in
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </FormShell>
    );
  }

  // Main sign-in
  return (
    <FormShell>
      <Card className="border-0 rounded-2xl shadow-[0_20px_60px_-15px_rgba(15,23,42,0.15)] bg-white">
        <CardHeader className="pt-10 space-y-2">
          <CardTitle className="text-3xl font-bold tracking-tight text-slate-900">
            Welcome back
          </CardTitle>
          <CardDescription className="text-slate-500 text-base">
            Sign in to manage ONECAB operations
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-10">
          <form onSubmit={handleSignIn} className="space-y-5">
            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="space-y-2">
              <Label htmlFor="signin-email" className="text-slate-900 font-semibold text-sm">
                Email
              </Label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <Input
                  id="signin-email"
                  type="email"
                  placeholder="Enter your email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="pl-11 h-12 rounded-xl border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-[#F4C430] focus-visible:border-[#F4C430]"
                  disabled={isSubmitting}
                  autoComplete="email"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="signin-password" className="text-slate-900 font-semibold text-sm">
                Password
              </Label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
                <Input
                  id="signin-password"
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Enter your password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="pl-11 pr-11 h-12 rounded-xl border-slate-200 bg-white text-slate-900 placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-[#F4C430] focus-visible:border-[#F4C430]"
                  disabled={isSubmitting}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-3 top-1/2 -translate-y-1/2 flex h-8 w-8 items-center justify-center rounded-md text-slate-400 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F4C430]"
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <Checkbox
                  id="remember"
                  checked={rememberMe}
                  onCheckedChange={(v) => setRememberMe(!!v)}
                  className="h-5 w-5 rounded-md border-slate-300 data-[state=checked]:bg-[#F4C430] data-[state=checked]:border-[#F4C430] data-[state=checked]:text-black"
                />
                <span className="text-sm text-slate-700">Remember me</span>
              </label>

              <button
                type="button"
                onClick={() => {
                  setShowForgotPassword(true);
                  setError(null);
                }}
                className="text-sm font-semibold text-slate-700 hover:text-slate-900 underline-offset-4 hover:underline"
              >
                Forgot password?
              </button>
            </div>

            <Button
              type="submit"
              className="w-full h-12 rounded-xl text-base font-semibold text-black hover:opacity-95 shadow-sm"
              style={{ backgroundColor: '#F4C430' }}
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Signing in...
                </>
              ) : (
                'Login'
              )}
            </Button>

            {/* Divider */}
            <div className="flex items-center gap-3 pt-1">
              <div className="h-px flex-1 bg-slate-200" />
              <span className="text-xs uppercase tracking-wider text-slate-400">or</span>
              <div className="h-px flex-1 bg-slate-200" />
            </div>

            {/* Restricted access notice */}
            <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50/60 p-4">
              <div
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                style={{ backgroundColor: '#FEF3C7' }}
              >
                <Lock className="h-4 w-4" style={{ color: '#B45309' }} />
              </div>
              <div className="text-sm leading-relaxed text-slate-700">
                <p className="font-semibold text-slate-900">Access is restricted.</p>
                <p className="text-slate-500">Contact a super admin to be invited.</p>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>
    </FormShell>
  );
}
