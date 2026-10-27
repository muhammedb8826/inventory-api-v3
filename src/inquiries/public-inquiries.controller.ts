import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PublicCreateInquiryDto } from './dto/inquiry.dto';
import { PublicCatalogQueryDto } from './dto/public-catalog-query.dto';
import { InquiriesService } from './inquiries.service';

/** Unauthenticated website / landing-page submissions. */
@ApiTags('public')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller('public')
export class PublicInquiriesController {
  constructor(private readonly service: InquiriesService) {}

  @Post('inquiries')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  create(@Body() dto: PublicCreateInquiryDto) {
    return this.service.createPublic(dto);
  }

  /** Active catalog for public inquiry product picker (no prices / stock). */
  @Get('catalog')
  catalog(@Query() query: PublicCatalogQueryDto) {
    return this.service.findPublicCatalog(query);
  }
}
