import "dotenv/config";
import bcrypt from "bcrypt";
import { prisma } from "../src/db/prisma.js"; // ajusta ruta si cambia

async function main() {
  const username = process.env.SUPERADMIN_USER ?? "admin";
  const password = process.env.SUPERADMIN_PASSWORD ?? "admin123";
  const passwordHash = await bcrypt.hash(password, 12);

  await prisma.adminUser.upsert({
    where: { username },
    update: { passwordHash, role: "SUPERADMIN", isActive: true },
    create: { username, passwordHash, role: "SUPERADMIN", isActive: true },
  });

  console.log(`✅ Superadmin listo: ${username}`);
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });

