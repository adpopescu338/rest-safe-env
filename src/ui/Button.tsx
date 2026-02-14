import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent,
} from 'react'
import './Button.css'

type Ripple = {
  id: number
  x: number
  y: number
  size: number
}

type Props = ButtonHTMLAttributes<HTMLButtonElement>

const RIPPLE_DURATION_MS = 520

const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { children, className, onClick, disabled, ...rest },
  ref
) {
  const [ripples, setRipples] = useState<Ripple[]>([])
  const nextRippleIdRef = useRef(1)
  const timeoutIdsRef = useRef<number[]>([])

  useEffect(() => {
    return () => {
      for (const timeoutId of timeoutIdsRef.current) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [])

  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    if (!disabled) {
      const bounds = event.currentTarget.getBoundingClientRect()
      const size = Math.max(bounds.width, bounds.height) * 1.9
      const rippleId = nextRippleIdRef.current
      nextRippleIdRef.current += 1

      setRipples((previous) => [
        ...previous,
        {
          id: rippleId,
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
          size,
        },
      ])

      const timeoutId = window.setTimeout(() => {
        setRipples((previous) => previous.filter((ripple) => ripple.id !== rippleId))
        timeoutIdsRef.current = timeoutIdsRef.current.filter((candidate) => candidate !== timeoutId)
      }, RIPPLE_DURATION_MS)

      timeoutIdsRef.current.push(timeoutId)
    }

    onClick?.(event)
  }

  return (
    <button
      {...rest}
      ref={ref}
      disabled={disabled}
      onClick={handleClick}
      className={['rse-button', className].filter(Boolean).join(' ')}
    >
      <span className="rse-button-label">{children}</span>
      <span className="rse-button-ripples" aria-hidden="true">
        {ripples.map((ripple) => (
          <span
            key={ripple.id}
            className="rse-button-ripple"
            style={{
              left: ripple.x,
              top: ripple.y,
              width: ripple.size,
              height: ripple.size,
            }}
          />
        ))}
      </span>
    </button>
  )
})

export default Button
