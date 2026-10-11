import { initTRPC, TRPCError } from "@trpc/server";

// Create context interface that can be extended by backend
export interface BaseContext {
  // Auth data that can be added by backend implementations
  // Using generic types so backends can use their own User/Session types
  user?: any;
  session?: any;
}

// Initialize tRPC with base context
const t = initTRPC.context<BaseContext>().create();

// Export router and procedure helpers
export const router = t.router;
export const publicProcedure = t.procedure;
export const createTRPCRouter = t.router;
export const baseProcedure = t.procedure;

// Create a protected procedure that requires authentication
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user || !ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You must be logged in to access this resource",
    });
  }

  return next({
    ctx: {
      ...ctx,
      // Override types to indicate user and session are guaranteed to exist
      user: ctx.user,
      session: ctx.session,
    },
  });
});

// Fork adaptation: upstream's adminProcedure is built on a users.role RBAC
// column that this fork does not carry (single-operator deployment). Every
// authenticated account here IS the operator, so admin today means
// "authenticated with a session". If this fork ever hosts multiple users,
// replace this with a real role check before doing anything else.
export const adminProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user || !ctx.session) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "You must be logged in to access this resource",
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
      session: ctx.session,
    },
  });
});
