import {
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  AuthenticationCreds,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Persists Baileys auth state (creds + signal keys) in MySQL via Prisma.
 * Each tenant gets one AuthState row tied to their WhatsAppSession.
 */
export class PrismaAuthState {
  constructor(
    private readonly tenantId: string,
    private readonly prisma: PrismaService,
  ) {}

  async init(): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
    const session = await this.prisma.whatsAppSession.findUniqueOrThrow({
      where: { tenantId: this.tenantId },
      include: { authState: true },
    });

    let creds: AuthenticationCreds;
    let keys: Record<string, any> = {};

    if (session.authState) {
      creds = JSON.parse(
        JSON.stringify(session.authState.creds),
        BufferJSON.reviver,
      ) as AuthenticationCreds;
      keys = JSON.parse(
        JSON.stringify(session.authState.keys),
        BufferJSON.reviver,
      );
    } else {
      creds = initAuthCreds();
    }

    const saveCreds = async () => {
      try {
        const serializedCreds = JSON.parse(JSON.stringify(creds, BufferJSON.replacer));
        const serializedKeys = JSON.parse(JSON.stringify(keys, BufferJSON.replacer));
        await this.prisma.authState.upsert({
          where: { sessionId: session.id },
          create: {
            sessionId: session.id,
            creds: serializedCreds,
            keys: serializedKeys,
          },
          update: {
            creds: serializedCreds,
            keys: serializedKeys,
          },
        });
      } catch (err: any) {
        // Baileys swallows errors thrown from event handlers — log loudly so
        // a broken save (which silently kills session persistence) is visible.
        console.error(`[PrismaAuthState] FAILED to save auth state for ${this.tenantId}:`, err.message);
        throw err;
      }
    };

    const state: AuthenticationState = {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(
          type: T,
          ids: string[],
        ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
          const data: Record<string, SignalDataTypeMap[T]> = {};
          for (const id of ids) {
            const val = keys[`${type}-${id}`];
            if (val) {
              data[id] =
                type === 'app-state-sync-key'
                  ? proto.Message.AppStateSyncKeyData.fromObject(val)
                  : val;
            }
          }
          return data;
        },
        set: async (data: Record<string, Record<string, any>>) => {
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries)) {
              if (value) {
                keys[`${type}-${id}`] = value;
              } else {
                delete keys[`${type}-${id}`];
              }
            }
          }
          await saveCreds();
        },
      },
    };

    return { state, saveCreds };
  }
}
