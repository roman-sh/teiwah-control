import { HttpException } from '@nestjs/common'

/**
 * Expected rejection from assertProvisionGate (429, 402, 503, etc.).
 * Intentional client response — not a server failure, do not log as error.
 */
export class ProvisionGateBlockedException extends HttpException {}
