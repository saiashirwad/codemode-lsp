import { type User, findUser } from "./users";

export type Token = string;

export class AuthService {
  private sessions = new Map<Token, User>();

  constructor();
  constructor(seed: Array<[Token, User]>);
  constructor(seed?: Array<[Token, User]>) {
    if (seed) {
      this.sessions = new Map(seed);
    }
  }

  /** Validate a token and return the associated user. */
  validate(token: Token): User | undefined {
    return this.sessions.get(token);
  }

  validateToken(token: Token): boolean {
    return this.sessions.has(token);
  }

  refreshSession(token: Token): Token | undefined {
    const user = this.sessions.get(token);
    if (!user) return undefined;
    this.sessions.delete(token);
    const next = `${token}-r`;
    this.sessions.set(next, user);
    return next;
  }

  logout(token: Token): void {
    this.sessions.delete(token);
  }
}

export function createAuthMiddleware(service: AuthService) {
  return (token: Token) => {
    const user = service.validate(token);
    if (!user) throw new Error("unauthorized");
    return findUser(user.id);
  };
}
