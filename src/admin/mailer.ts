import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendAdminOtpEmail(to: string, code: string) {
  await resend.emails.send({
    from: process.env.RESEND_FROM!, // no-reply@hidracode.cl
    to,
    subject: "Código de verificación FENATS (Admin)",
    html: `
      <div style="font-family:system-ui,Segoe UI,Roboto,Arial">
        <h2>Tu código de verificación</h2>
        <p>Ingresa este código para completar el inicio de sesión:</p>
        <div style="font-size:28px;font-weight:800;letter-spacing:6px;margin:16px 0">${code}</div>
        <p style="color:#666">Este código expira en 10 minutos.</p>
      </div>
    `,
  });
}


