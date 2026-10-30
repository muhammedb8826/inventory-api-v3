import { PublicCatalogQueryDto } from './dto/public-catalog-query.dto';
import { ApiBody, ApiConsumes, ApiProduces } from '@nestjs/swagger';
import { FilesInterceptor } from '@nestjs/platform-express';
import { inquiryUploadOptions } from './inquiry-attachments';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  StreamableFile,
  ParseUUIDPipe,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { JwtPayload } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import {
  CreateInquiryDto,
  InquiryListQueryDto,
  UpdateInquiryDto,
} from './dto/inquiry.dto';
import { InquiriesService } from './inquiries.service';

@Controller('inquiries')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class InquiriesController {
  constructor(private readonly service: InquiriesService) {}

  @Get()
  @RequirePermissions('inquiries.read')
  findAll(@Query() query: InquiryListQueryDto) {
    return this.service.findAll(query);
  }

  @Get('catalog')
  catalog(@Query() query: PublicCatalogQueryDto) {
    return this.service.findPublicCatalog(query);
  }

  @Get(':id')
  @RequirePermissions('inquiries.read')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Post()
  @RequirePermissions('inquiries.write')
  create(@CurrentUser() user: JwtPayload, @Body() dto: CreateInquiryDto) {
    return this.service.createInternal(dto, user.sub);
  }

  @Patch(':id')
  @RequirePermissions('inquiries.write')
  update(
    @CurrentUser() user: JwtPayload,
    @Param('id') id: string,
    @Body() dto: UpdateInquiryDto,
  ) {
    return this.service.update(id, dto, user.sub);
  }

  @Post(':id/attachments')
  @RequirePermissions('inquiries.write')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['files'],
      properties: {
        files: {
          type: 'array',
          maxItems: 5,
          items: { type: 'string', format: 'binary' },
        },
      },
    },
  })
  @UseInterceptors(FilesInterceptor('files', 5, inquiryUploadOptions))
  upload(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.service.addAttachments(id, files);
  }
  @Get(':id/attachments/:attachmentId')
  @RequirePermissions('inquiries.read')
  @ApiProduces('application/octet-stream')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    const file = await this.service.downloadAttachment(id, attachmentId);
    return new StreamableFile(file.data, {
      type: file.mime,
      length: file.size,
      disposition: `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    });
  }
  @Delete(':id/attachments/:attachmentId')
  @RequirePermissions('inquiries.write')
  removeAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    return this.service.removeAttachment(id, attachmentId);
  }

  @Post(':id/accept')
  @RequirePermissions('inquiries.write')
  accept(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.service.accept(id, user.sub);
  }

  @Post(':id/decline')
  @RequirePermissions('inquiries.write')
  decline(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.service.decline(id, user.sub);
  }

  @Post(':id/claim')
  @RequirePermissions('inquiries.write')
  claim(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.service.claim(id, user.sub);
  }

  /** Firm demand: mark inquiry as QUOTED so production can plan against it. */
  @Post(':id/confirm')
  @RequirePermissions('inquiries.write')
  confirm(@CurrentUser() user: JwtPayload, @Param('id') id: string) {
    return this.service.confirm(id, user.sub);
  }

  @Post(':id/close')
  @RequirePermissions('inquiries.write')
  close(@Param('id') id: string) {
    return this.service.close(id);
  }

  @Delete(':id')
  @RequirePermissions('inquiries.write')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
