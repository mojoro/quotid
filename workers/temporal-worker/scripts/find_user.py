"""Print the first User row's id. Used by the trigger helper."""

import asyncio
from prisma import Prisma


async def main() -> None:
    p = Prisma()
    await p.connect()
    user = await p.user.find_first()
    if user is None:
        raise SystemExit("No User row found. Did the seed run?")
    print(user.id)
    await p.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
