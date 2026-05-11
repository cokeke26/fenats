# FENATS – Sistema de Gestión de Socios y Validación por QR

Sistema web desarrollado para **FENATS** que permite la **gestión administrativa de socios**, la **importación masiva desde Excel**, la **generación de credenciales con código QR** y la **validación pública de vigencia** para convenios.

Incluye **panel administrativo con autenticación segura (2FA por correo)** y una **validación pública optimizada para móviles**.

---

## 🚀 Funcionalidades principales

### 🔐 Panel Administrativo
- Login con **usuario + contraseña**
- **Segundo factor de autenticación (2FA)** mediante código OTP enviado por correo
- Roles:
  - **SUPERADMIN**: control total
  - **ADMIN**: gestión de socios
  - **VIEWER**: solo lectura

### 👥 Gestión de Socios
- Crear y editar socios manualmente
- Activar / inactivar socios
- Regenerar token de validación
- Descarga de QR individual
- Vista responsive optimizada para móvil (scroll horizontal)

### 📥 Importación Masiva desde Excel
- Soporta archivos `.xlsx` y `.xls`
- Detecta la tabla aunque **no comience en A1**
- Acepta RUT:
  - Con o sin puntos
  - Con DV separado o unido
- Crea o actualiza socios automáticamente por RUT
- Manejo de filas inválidas (omitidas)

### 🪪 Credencial Digital
- Credencial imprimible por socio
- Código QR único por socio
- Vista optimizada para impresión y móvil

### ✅ Validación Pública
- Endpoint público para validación por QR
- Muestra:
  - Nombre
  - RUT
  - Filial
  - Estado (Vigente / No vigente)
- **No expone información sensible**
- Ideal para convenios y control externo

---

## 🧠 Flujo de Seguridad (Admin)

1. Usuario ingresa **username + password**
2. Sistema envía **código OTP por correo**
3. Usuario valida OTP
4. Se crea sesión segura

---

## 🛠️ Tecnologías utilizadas

- **Node.js**
- **Express**
- **TypeScript**
- **Prisma ORM**
- **PostgreSQL**
- **EJS (views)**
- **Resend (correo 2FA)**
- **bcrypt**
- **express-session**
- **xlsx**
- **QRCode**

## ⚙️ Variables de entorno

Crear un archivo `.env`:

```env
DATABASE_URL=postgresql://user:password@localhost:5432/fenats
SESSION_SECRET=super-secret-key
RESEND_API_KEY=re_xxxxxxxxx
ADMIN_PASSWORD="ejemplo123"
SUPERADMIN_USER="admin"
SUPERADMIN_PASSWORD="admin123"
RESEND_FROM=FENATS <no-reply@tudominio.cl>
PUBLIC_BASE_URL=http://localhost:3000

```
---


## ▶️ Instalación y ejecución

```
npm install
npx prisma migrate dev
npx prisma db seed
npx prisma generate
npm run dev

```

---

## 📱 Mobile first

- Todas las vistas administrativas son responsive

- Tablas con scroll horizontal

- Validación pública optimizada para celular

- Credenciales listas para impresión

---

## 🔒 Consideraciones de Seguridad

- Passwords hasheadas con bcrypt

- OTP con expiración y límite de intentos

- Sesiones seguras con express-session

- Validación pública sin exponer datos críticos

## 📌 Estado del proyecto

- ✅ Funcional y operativo
- 🔧 Extensible (login de socios, historial de validaciones, auditoría, etc.)

## 👨‍💻 Autor

- Hidracode Solutions
- Desarrollo de software a medida, sistemas administrativos y soluciones digitales.

## 📄 Licencia

Proyecto privado – Uso interno FENATS.

## 📸 Capturas

![Login Admin](assets/photos/login-admin.png)
![Dashboard](assets/photos/dashboard.png)
![Credencial QR](assets/photos/credential.png)
