// a synthetic NestJS app, shared by the Nest adapter unit test + the
// contribution-step integration test (we have no connected Nest repo yet, so the
// hermetic fixture IS the gate).
//
// The layout is deliberately LAYERED (controllers/ · services/ · modules/ ·
// common/) so the DIRECTORY heuristic would group by layer (a "controllers"
// subsystem, a "services" subsystem). The @Module declarations group by FEATURE
// (Users = its controller + service + module file; Orders likewise). The test
// asserts the rendered subsystem follows the @Module — proving the grouping prior
// BEATS directory.
//
//   src/app.module.ts            AppModule — imports Users + Orders             [module]
//   src/modules/users.module.ts  @Module(controllers:[UsersController],
//                                   providers/exports:[UsersService])           [module]
//   src/modules/orders.module.ts @Module(imports:[UsersModule], …) + a
//                                   useFactory custom provider (degrade+log)    [module]
//   src/controllers/users.controller.ts   @Controller, DI UsersService          [controller]
//   src/controllers/orders.controller.ts  @Controller, DI OrdersService         [controller]
//   src/services/users.service.ts         @Injectable                            [service]
//   src/services/orders.service.ts        @Injectable, DI UsersService +
//                                           @Inject('CONFIG') (unresolved → log)  [service]
//   src/common/roles.guard.ts             @Injectable implements CanActivate     [guard]
//   src/common/logging.interceptor.ts     @Injectable implements NestInterceptor [interceptor]
//   src/common/parse-int.pipe.ts          @Injectable implements PipeTransform    [pipe]
//   src/graphql/users.resolver.ts         @Resolver                              [resolver]
//
// Expected DI ('calls') edges (file-id space): users.controller→users.service,
// orders.controller→orders.service, orders.service→users.service; @Module imports:
// orders.module→users.module, app.module→users.module, app.module→orders.module.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'nest-fixture',
      dependencies: {
        '@nestjs/core': '10.0.0',
        '@nestjs/common': '10.0.0',
        '@nestjs/graphql': '12.0.0',
      },
    },
    null,
    2,
  ),
  'nest-cli.json': JSON.stringify({ collection: '@nestjs/schematics' }, null, 2),
  'tsconfig.json': JSON.stringify(
    { compilerOptions: { experimentalDecorators: true, emitDecoratorMetadata: true } },
    null,
    2,
  ),

  // --- the @Module wiring (modules/) ---------------------------------------
  'src/app.module.ts': `
import { Module } from '@nestjs/common';
import { UsersModule } from './modules/users.module';
import { OrdersModule } from './modules/orders.module';

@Module({
  imports: [UsersModule, OrdersModule],
})
export class AppModule {}
`,
  'src/modules/users.module.ts': `
import { Module } from '@nestjs/common';
import { UsersController } from '../controllers/users.controller';
import { UsersService } from '../services/users.service';
import { UsersRepository } from '../services/users.repository';

@Module({
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService],
})
export class UsersModule {}
`,
  'src/modules/orders.module.ts': `
import { Module } from '@nestjs/common';
import { UsersModule } from './users.module';
import { OrdersController } from '../controllers/orders.controller';
import { OrdersService } from '../services/orders.service';
import { OrdersRepository } from '../services/orders.repository';

@Module({
  imports: [UsersModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrdersRepository,
    // A custom provider with no statically-knowable class file → degrade + log.
    { provide: 'CONFIG', useFactory: () => ({ region: 'eu' }) },
  ],
})
export class OrdersModule {}
`,

  // --- controllers/ ---------------------------------------------------------
  'src/controllers/users.controller.ts': `
import { Controller, Get } from '@nestjs/common';
import { UsersService } from '../services/users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.findAll();
  }
}
`,
  'src/controllers/orders.controller.ts': `
import { Controller, Get } from '@nestjs/common';
import { OrdersService } from '../services/orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get()
  list() {
    return this.orders.list();
  }
}
`,

  // --- services/ ------------------------------------------------------------
  'src/services/users.service.ts': `
import { Injectable } from '@nestjs/common';
import { UsersRepository } from './users.repository';

@Injectable()
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}

  findAll(): string[] {
    return this.repo.all();
  }
}
`,
  'src/services/users.repository.ts': `
import { Injectable } from '@nestjs/common';

@Injectable()
export class UsersRepository {
  all(): string[] {
    return ['ada', 'linus'];
  }
}
`,
  'src/services/orders.service.ts': `
import { Inject, Injectable } from '@nestjs/common';
import { UsersService } from './users.service';
import { OrdersRepository } from './orders.repository';

@Injectable()
export class OrdersService {
  constructor(
    private readonly users: UsersService,
    private readonly repo: OrdersRepository,
    @Inject('CONFIG') private readonly config: unknown,
  ) {}

  list(): string[] {
    void this.config;
    return this.repo.all(this.users.findAll());
  }
}
`,
  'src/services/orders.repository.ts': `
import { Injectable } from '@nestjs/common';

@Injectable()
export class OrdersRepository {
  all(users: string[]): string[] {
    return users.map((u) => 'order:' + u);
  }
}
`,

  // --- common/ (cross-cutting; NOT in any @Module group) --------------------
  'src/common/roles.guard.ts': `
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class RolesGuard implements CanActivate {
  canActivate(_ctx: ExecutionContext): boolean {
    return true;
  }
}
`,
  'src/common/logging.interceptor.ts': `
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler) {
    return next.handle();
  }
}
`,
  'src/common/parse-int.pipe.ts': `
import { Injectable, PipeTransform } from '@nestjs/common';

@Injectable()
export class ParseIntPipe implements PipeTransform {
  transform(value: string): number {
    return parseInt(value, 10);
  }
}
`,

  // --- graphql/ -------------------------------------------------------------
  'src/graphql/users.resolver.ts': `
import { Query, Resolver } from '@nestjs/graphql';
import { UsersService } from '../services/users.service';

@Resolver()
export class UsersResolver {
  constructor(private readonly users: UsersService) {}

  @Query(() => [String])
  users() {
    return this.users.findAll();
  }
}
`,
};

export const NEST_FIXTURE_FILES = {
  appModule: 'src/app.module.ts',
  usersModule: 'src/modules/users.module.ts',
  ordersModule: 'src/modules/orders.module.ts',
  usersController: 'src/controllers/users.controller.ts',
  ordersController: 'src/controllers/orders.controller.ts',
  usersService: 'src/services/users.service.ts',
  usersRepository: 'src/services/users.repository.ts',
  ordersService: 'src/services/orders.service.ts',
  ordersRepository: 'src/services/orders.repository.ts',
  rolesGuard: 'src/common/roles.guard.ts',
  loggingInterceptor: 'src/common/logging.interceptor.ts',
  parseIntPipe: 'src/common/parse-int.pipe.ts',
  usersResolver: 'src/graphql/users.resolver.ts',
} as const;

/** Write the NestJS fixture tree under `dir`. */
export async function writeNestFixture(dir: string): Promise<void> {
  for (const [rel, content] of Object.entries(FILES)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content.startsWith('\n') ? content.slice(1) : content);
  }
}
