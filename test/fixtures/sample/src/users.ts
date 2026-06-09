export interface User {
  id: string;
  name: string;
  role: UserRole;
}

export type UserRole = "admin" | "member";

const registry: User[] = [
  { id: "u1", name: "Ada", role: "admin" },
  { id: "u2", name: "Lin", role: "member" },
];

export function findUser(id: string): User | undefined {
  return registry.find((u) => u.id === id);
}

export const isAdmin = (user: User): boolean => user.role === "admin";

export class Outer {
  static label = "outer";

  static Inner = class {
    describe(): string {
      return Outer.label;
    }
  };

  method(): string {
    return Outer.label;
  }
}

export const router = {
  get(path: string): string {
    return `GET ${path}`;
  },
  post(path: string): string {
    return `POST ${path}`;
  },
};
