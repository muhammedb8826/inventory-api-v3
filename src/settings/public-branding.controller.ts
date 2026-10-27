import { Controller, Get, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { SettingsService } from './settings.service';

function requestBaseUrl(req: Request) {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  const host = req.get('host');
  return host ? `${proto}://${host}` : undefined;
}

/** Unauthenticated branding for the public / marketing site. */
@ApiTags('public')
@Throttle({ default: { limit: 120, ttl: 60_000 } })
@Controller('public/branding')
export class PublicBrandingController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  get(@Req() req: Request) {
    return this.settings.getBranding(requestBaseUrl(req));
  }
}
