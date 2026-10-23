/**
 * Máquinas de estado declarativas para documentos.
 * Una transición no permitida SIEMPRE lanza error: nunca se ignora en silencio.
 */
export interface StateMachine<S extends string, A extends string> {
  name: string;
  initial: S;
  transitions: Record<A, { from: readonly S[]; to: S }>;
}

export class TransitionError extends Error {
  constructor(
    readonly machine: string,
    readonly from: string,
    readonly action: string,
  ) {
    super(`${machine}: la acción "${action}" no está permitida en estado "${from}"`);
    this.name = "TransitionError";
  }
}

export function defineMachine<S extends string, A extends string>(m: StateMachine<S, A>) {
  return {
    ...m,
    next(from: S, action: A): S {
      const t = m.transitions[action];
      if (!t || !t.from.includes(from)) throw new TransitionError(m.name, from, action);
      return t.to;
    },
    can(from: S, action: A): boolean {
      const t = m.transitions[action];
      return !!t && t.from.includes(from);
    },
    actions(from: S): A[] {
      return (Object.keys(m.transitions) as A[]).filter((a) => m.transitions[a].from.includes(from));
    },
  };
}

export const SalesOrderMachine = defineMachine({
  name: "Pedido de venta",
  initial: "draft",
  transitions: {
    confirm: { from: ["draft"], to: "confirmed" },
    deliver: { from: ["confirmed"], to: "delivered" },
    invoice: { from: ["delivered"], to: "invoiced" },
    cancel: { from: ["draft", "confirmed"], to: "cancelled" },
  },
} as const);
export type SalesOrderState = "draft" | "confirmed" | "delivered" | "invoiced" | "cancelled";

/**
 * Factura: una vez emitida es inmutable (VERI*FACTU). Solo se corrige con una rectificativa.
 * No existe la acción "volver a borrador" ni "borrar" desde emitida.
 */
export const InvoiceMachine = defineMachine({
  name: "Factura",
  initial: "draft",
  transitions: {
    issue: { from: ["draft"], to: "issued" },
    pay: { from: ["issued"], to: "paid" },
    discard: { from: ["draft"], to: "discarded" },
    rectify: { from: ["issued"], to: "rectified" },
  },
} as const);
export type InvoiceState = "draft" | "issued" | "paid" | "discarded" | "rectified";

/**
 * Presupuesto: se prepara en borrador, se envía y el cliente lo acepta o lo rechaza. Uno
 * enviado puede volver a borrador para corregirlo. Aceptado o rechazado ya no cambia.
 */
export const QuotationMachine = defineMachine({
  name: "Presupuesto",
  initial: "draft",
  transitions: {
    send: { from: ["draft"], to: "sent" },
    edit: { from: ["sent"], to: "draft" },
    accept: { from: ["draft", "sent"], to: "accepted" },
    reject: { from: ["sent"], to: "rejected" },
    cancel: { from: ["draft", "sent"], to: "cancelled" },
  },
} as const);
export type QuotationState = "draft" | "sent" | "accepted" | "rejected" | "cancelled";
export type QuotationAction = keyof typeof QuotationMachine.transitions;
